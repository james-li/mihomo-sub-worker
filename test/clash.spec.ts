import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	cleanProxies,
	parseClashSubscription,
	renderClash,
	type TaggedProxy,
} from "../src/clash";
import type { SubscriptionSource } from "../src/config";

const source = (tags: string[] = []): SubscriptionSource => ({
	id: "source-1",
	url: "https://example.com/sub",
	tags,
	enabled: true,
});

describe("Clash parsing and filtering", () => {
	it("parses proxies and preserves source tags outside the proxy object", () => {
		const result = parseClashSubscription(
			"proxies:\n  - { name: HK-01, type: ss, server: hk.example.com, port: 443, password: secret, cipher: aes-128-gcm }\n",
			source(["WORK", "HK"]),
		);
		expect(result).toHaveLength(1);
		expect(result[0].tags).toEqual(["WORK", "HK"]);
		expect(result[0].proxy).not.toHaveProperty("tags");
	});

	it("filters information nodes, deduplicates, and isolates PRIVATE", async () => {
		const yaml = `proxies:
  - { name: 剩余流量 20GB, type: ss, server: info.example.com, port: 1 }
  - { name: 流量优化-HK, type: ss, server: hk.example.com, port: 443, password: secret }
`;
		const publicItems = parseClashSubscription(yaml, source([]));
		const privateItems = parseClashSubscription(
			"proxies:\n  - { name: Private-HK, type: ss, server: private.example.com, port: 443, password: private-secret }\n",
			source(["PRIVATE"]),
		);
		const duplicate: TaggedProxy = {
			...publicItems[1],
			tags: ["BACKUP"],
			sourceId: "source-2",
		};

		const admin = await cleanProxies(
			[...publicItems, duplicate, ...privateItems],
			"admin",
		);
		const user = await cleanProxies(
			[...publicItems, duplicate, ...privateItems],
			"user",
		);

		expect(admin.map((item) => item.proxy.name)).toEqual([
			"流量优化-HK [BACKUP]",
			"Private-HK [PRIVATE]",
		]);
		expect(admin[0].tags).toEqual(["BACKUP"]);
		expect(user.map((item) => item.proxy.name)).toEqual(["流量优化-HK [BACKUP]"]);
	});

	it("appends merged source tags to names before ACL matching", async () => {
		const original = parseClashSubscription(
			"proxies:\n  - { name: Node, type: ss, server: tag.example.com, port: 443, password: secret }\n",
			source(["TAISHAN"]),
		)[0];
		const duplicate: TaggedProxy = {
			...original,
			tags: ["LLG"],
			sourceId: "source-2",
		};
		const result = await cleanProxies([original, duplicate], "admin");
		expect(result).toHaveLength(1);
		expect(result[0].tags).toEqual(["TAISHAN", "LLG"]);
		expect(result[0].proxy.name).toBe("Node [TAISHAN] [LLG]");
	});

	it("renders YAML that can be parsed again", async () => {
		const proxies = await cleanProxies(
			parseClashSubscription(
				"proxies:\n  - { name: HK-01, type: ss, server: hk.example.com, port: 443, password: secret }\n",
				source(),
			),
			"admin",
		);
		const rendered = renderClash(
				proxies,
				[{ name: "节点选择", type: "select", proxies: ["HK-01"] }],
				["MATCH,节点选择"],
		);
		expect(rendered).toMatch(
			/^\s*- \{name: HK-01, type: ss, server: hk\.example\.com, port: 443, password: secret\}$/m,
		);
		const document = parse(rendered);
		expect(document.port).toBe(7890);
		expect(document.proxies).toHaveLength(1);
		expect(document["proxy-groups"][0].proxies).toEqual(["HK-01"]);
	});

	it("renders nested proxy options in the same flow-style line", () => {
		const rendered = renderClash(
			[
				{
					sourceId: "vless",
					tags: [],
					proxy: {
						name: "VLESS-WS",
						type: "vless",
						server: "edge.example.com",
						port: 443,
						uuid: "11111111-1111-1111-1111-111111111111",
						tls: true,
						network: "ws",
						"ws-opts": {
							path: "/websocket",
							headers: { Host: "edge.example.com" },
						},
					},
				},
			],
			[],
			[],
		);
		const proxyLine = rendered
			.split("\n")
			.find((line) => line.trimStart().startsWith("- {name: VLESS-WS"));
		expect(proxyLine).toContain(
			"ws-opts: {path: /websocket, headers: {Host: edge.example.com}}",
		);
		expect(parse(rendered).proxies[0]["ws-opts"].headers.Host).toBe(
			"edge.example.com",
		);
	});

	it("keeps generated proxy names unique when suffixes already exist", async () => {
		const items = parseClashSubscription(
			`proxies:
  - { name: Node, type: ss, server: one.example.com, port: 443, password: one }
  - { name: Node, type: ss, server: two.example.com, port: 443, password: two }
  - { name: Node · 2, type: ss, server: three.example.com, port: 443, password: three }
`,
			source(),
		);
		const result = await cleanProxies(items, "admin");
		const names = result.map((item) => item.proxy.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toEqual(["Node", "Node · 2", "Node · 2 · 2"]);
	});
});
