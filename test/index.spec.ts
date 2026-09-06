import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG_KEY } from "../src/config";
import { ADMIN_APP_JS } from "../src/ui";

describe("fgfwsub worker", () => {
	beforeEach(async () => {
		await env.CONFIG_KV.delete(CONFIG_KEY);
	});

	it("returns 404 without exposing keys for an unknown route", async () => {
		const response = await SELF.fetch("https://example.com/not-a-key");
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("test-admin-key");
	});

	it("serves the admin page to a browser", async () => {
		const response = await SELF.fetch("https://example.com/test-admin-key", {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		const html = await response.text();
		expect(html).toContain("订阅编辑器");
		expect(html).toContain("用户订阅二维码");
		expect(html).toContain('src="/test-admin-key/app.js"');
	});

	it("serves the user subscription QR code only below the admin route", async () => {
		const response = await SELF.fetch(
			"https://example.com/test-admin-key/api/subscription-qr.svg",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("image/svg+xml");
		expect(response.headers.get("cache-control")).toBe("no-store");
		const svg = await response.text();
		expect(svg).toContain("<svg");
		expect(svg).not.toContain("test-user-key");

		const userResponse = await SELF.fetch(
			"https://example.com/test-user-key/api/subscription-qr.svg",
		);
		expect(userResponse.status).toBe(404);
	});

	it("ships syntactically valid admin JavaScript", () => {
		expect(() => new Function(ADMIN_APP_JS)).not.toThrow();
	});

	it("always returns clash.yml for the user key", async () => {
		for (const userAgent of ["Mozilla/5.0", "Clash.Meta", ""]) {
			const response = await SELF.fetch("https://example.com/test-user-key", {
				headers: { "user-agent": userAgent },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/yaml");
			expect(response.headers.get("content-disposition")).toContain(
				'filename="clash.yml"',
			);
			expect(await response.text()).not.toContain("<html");
		}
	});

	it("loads a default configuration", async () => {
		const response = await SELF.fetch(
			"https://example.com/test-admin-key/api/config",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ version: 0, sources: [] });
	});

	it("normalizes tags and stores only config_current", async () => {
		const response = await SELF.fetch(
			"https://example.com/test-admin-key/api/config",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					version: 0,
					sources: [
						{
							id: "source-1",
							url: "https://example.com/sub#PRIVATE_HK_PRIVATE",
							enabled: true,
						},
					],
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			version: 1,
			sources: [
				{
					id: "source-1",
					url: "https://example.com/sub",
					tags: ["PRIVATE", "HK"],
					enabled: true,
				},
			],
		});
		const keys = await env.CONFIG_KV.list();
		expect(keys.keys.map((key) => key.name)).toEqual([CONFIG_KEY]);
	});

	it("rejects a stale config version", async () => {
		await env.CONFIG_KV.put(
			CONFIG_KEY,
			JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), sources: [] }),
		);
		const response = await SELF.fetch(
			"https://example.com/test-admin-key/api/config",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version: 1, sources: [] }),
			},
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "config_version_conflict" });
	});

	it("rejects private-network subscription URLs", async () => {
		const response = await SELF.fetch(
			"https://example.com/test-admin-key/api/config",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					version: 0,
					sources: [{ url: "https://127.0.0.1/sub", enabled: true }],
				}),
			},
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_source_url" });
	});

	it("stores and returns complete file and protocol URL sources in config_current", async () => {
		const protocolUrl = "trojan://admin-secret@example.com:443?security=tls#Private";
		const fileContent = "vless://file-uuid@file.example.com:443?security=tls#FromFile";
		const response = await SELF.fetch("https://example.com/test-admin-key/api/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				version: 0,
				sources: [
					{ id: "file-source", type: "file", fileName: "nodes.txt", content: fileContent, tags: ["PRIVATE"], enabled: true },
					{ id: "protocol-source", type: "protocol_url", protocolUrl, tags: ["SELF"], enabled: true },
				],
			}),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as { sources: Array<Record<string, unknown>> };
		expect(body.sources[0]).toMatchObject({ type: "file", content: fileContent, fileName: "nodes.txt", size: fileContent.length });
		expect(body.sources[1]).toMatchObject({ type: "protocol_url", protocolUrl, protocol: "trojan" });
		const stored = await env.CONFIG_KV.get(CONFIG_KEY);
		expect(stored).toContain(fileContent);
		expect(stored).toContain(protocolUrl);
		const keys = await env.CONFIG_KV.list();
		expect(keys.keys.map((key) => key.name)).toEqual([CONFIG_KEY]);
	});
});
