import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import type { AppEnv } from "../src/env";
import { generateSubscription, GenerationError } from "../src/generate";

const config: AppConfig = {
	version: 1,
	updatedAt: "2026-09-06T00:00:00.000Z",
	sources: [
		{ id: "good", url: "https://good.example/sub", tags: [], enabled: true },
		{ id: "bad", url: "https://bad.example/sub", tags: [], enabled: true },
	],
};

const fakeEnv = {
	ACC4SSR_INI: "https://acl.example/config.ini",
} as AppEnv;

afterEach(() => vi.unstubAllGlobals());

describe("subscription generation", () => {
	it("generates a partial subscription when one source fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "https://good.example/sub") {
					return new Response(
						"proxies:\n  - { name: HK-01, type: ss, server: hk.example.com, port: 443, password: secret }\n",
					);
				}
				if (url === "https://bad.example/sub") return new Response("bad", { status: 503 });
				if (url === "https://acl.example/config.ini") {
					return new Response(
						"ruleset=节点选择,[]FINAL\ncustom_proxy_group=节点选择`select`[]DIRECT`.*\n",
					);
				}
				throw new Error("unexpected URL");
			}),
		);
		const result = await generateSubscription(fakeEnv, config, "user");
		expect(result.partial).toBe(true);
		expect(result.failedSources).toBe(1);
		expect(result.nodes).toBe(1);
		expect(result.yaml).toContain("HK-01");
	});

	it("returns a specific failure when every source fails", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 503 })));
		const uncachedConfig: AppConfig = {
			...config,
			sources: config.sources.map((source) => ({
				...source,
				url: `https://uncached-${source.id}.example/sub`,
			})),
		};
		await expect(
			generateSubscription(fakeEnv, uncachedConfig, "admin"),
		).rejects.toBeInstanceOf(GenerationError);
	});

	it("combines file and protocol_url sources without fetching them", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) === "https://acl.example/config.ini") {
					return new Response("ruleset=节点选择,[]FINAL\ncustom_proxy_group=节点选择`select`[]DIRECT`.*\n");
				}
				throw new Error("unexpected source fetch");
			}),
		);
		const mixed: AppConfig = {
			version: 2,
			updatedAt: "2026-09-06T00:00:00.000Z",
			sources: [
				{
					id: "file", type: "file", fileName: "nodes.txt", content: "vless://uuid@file.example.com:443?security=tls#FileNode",
					tags: [], enabled: true, format: "auto",
				},
				{
					id: "direct", type: "protocol_url", name: "来源指定名称", protocolUrl: "trojan://secret@direct.example.com:443?security=tls#LinkFragmentName",
					tags: [], enabled: true,
				},
			],
		};
		const result = await generateSubscription(fakeEnv, mixed, "admin");
		expect(result.nodes).toBe(2);
		expect(result.sites.map((site) => site.name)).toEqual(["FileNode", "来源指定名称"]);
		expect(result.yaml).toContain("file.example.com");
		expect(result.yaml).toContain("direct.example.com");
	});
});
