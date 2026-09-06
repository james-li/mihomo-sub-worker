import { describe, expect, it } from "vitest";
import { compileAcl, parseAclIni } from "../src/acl";
import type { TaggedProxy } from "../src/clash";

function proxy(name: string, tags: string[] = []): TaggedProxy {
	return {
		sourceId: "source",
		tags,
		proxy: {
			name,
			type: "ss",
			server: `${name.toLowerCase()}.example.com`,
			port: 443,
			password: "secret",
		},
	};
}

describe("ACL4SSR parsing and compilation", () => {
	it("supports positive, negative, AND, and tag expressions", async () => {
		const definition = parseAclIni(`[custom]
custom_proxy_group=positive\`select\`TAISHAN
custom_proxy_group=negative\`select\`!TAISHAN
custom_proxy_group=parallel\`select\`!TAISHAN&&!LLG
custom_proxy_group=mixed\`select\`HK&&!VIP
custom_proxy_group=tagged\`select\`.*\`!!TAG=WORK
`);
		const compiled = await compileAcl(definition, [
			proxy("TAISHAN-HK", ["WORK"]),
			proxy("LLG-US"),
			proxy("HK-VIP"),
			proxy("HK-01", ["WORK"]),
		]);
		const groups = Object.fromEntries(
			compiled.groups.map((group) => [group.name, group.proxies]),
		);
		expect(groups.positive).toEqual(["TAISHAN-HK"]);
		expect(groups.negative).toEqual(["LLG-US", "HK-VIP", "HK-01"]);
		expect(groups.parallel).toEqual(["HK-VIP", "HK-01"]);
		expect(groups.mixed).toEqual(["TAISHAN-HK", "HK-01"]);
		expect(groups.tagged).toEqual(["TAISHAN-HK", "HK-01"]);
	});

	it("compiles inline GEOIP and FINAL rules", async () => {
		const definition = parseAclIni(`[custom]
ruleset=节点选择,[]GEOIP,CN
ruleset=节点选择,[]FINAL
custom_proxy_group=节点选择\`select\`[]DIRECT\`.*
`);
		const compiled = await compileAcl(definition, [proxy("HK-01")]);
		expect(compiled.rules).toEqual(["GEOIP,CN,节点选择", "MATCH,节点选择"]);
	});

	it("accepts the HTTP health-check URLs used by the configured ACL", async () => {
		const definition = parseAclIni(
			"custom_proxy_group=自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,,50",
		);
		const compiled = await compileAcl(definition, [proxy("HK-01")]);
		expect(compiled.groups[0]).toMatchObject({
			name: "自动选择",
			type: "url-test",
			url: "http://www.gstatic.com/generate_204",
			interval: 300,
			tolerance: 50,
		});
	});

	it("rejects invalid regular expressions", async () => {
		const definition = parseAclIni(
			"custom_proxy_group=broken`select`[invalid",
		);
		await expect(compileAcl(definition, [proxy("HK-01")])).rejects.toMatchObject({
			code: "invalid_name_expression",
		});
	});
});
