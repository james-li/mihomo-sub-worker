import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { CONFIG_KEY } from "../src/config";

const ACL =
	"ruleset=节点选择,[]FINAL\ncustom_proxy_group=节点选择`select`[]DIRECT`.*\n";

describe("subscription download route", () => {
	beforeEach(async () => {
		await env.CONFIG_KV.put(
			CONFIG_KEY,
			JSON.stringify({
				version: 91,
				updatedAt: "2026-09-06T00:00:00.000Z",
				sources: [
					{
						id: "public",
						url: "https://route-public.example/sub",
						tags: [],
						enabled: true,
					},
					{
						id: "private",
						url: "https://route-private.example/sub",
						tags: ["PRIVATE"],
						enabled: true,
					},
					{
						id: "failed",
						url: "https://route-failed.example/sub",
						tags: [],
						enabled: true,
					},
				],
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "https://route-public.example/sub") {
					return new Response(
						"proxies:\n  - { name: Public-HK, type: ss, server: public.example.com, port: 443, password: public-secret }\n",
					);
				}
				if (url === "https://route-private.example/sub") {
					return new Response(
						"proxies:\n  - { name: Private-HK, type: ss, server: private.example.com, port: 443, password: private-secret }\n",
					);
				}
				if (url === "https://route-failed.example/sub") {
					return new Response("unavailable", { status: 503 });
				}
				if (url === "https://example.com/acl.ini") return new Response(ACL);
				throw new Error(`Unexpected outbound request: ${url}`);
			}),
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("returns a valid partial user YAML without PRIVATE proxies", async () => {
		const response = await SELF.fetch("https://example.com/test-user-key", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("x-fgfwsub-partial")).toBe("1");
		expect(response.headers.get("x-fgfwsub-failed-sources")).toBe("1");
		const document = parse(await response.text());
		expect(document.proxies.map((proxy: { name: string }) => proxy.name)).toEqual([
			"Public-HK",
		]);
		expect(JSON.stringify(document["proxy-groups"])).not.toContain("Private-HK");
	});
});
