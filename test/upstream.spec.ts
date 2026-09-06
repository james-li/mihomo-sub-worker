import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText, validateUpstreamUrl } from "../src/upstream";

afterEach(() => vi.unstubAllGlobals());

describe("safe upstream fetch", () => {
	it("rejects local and private literal addresses", () => {
		for (const url of [
			"https://localhost/sub",
			"https://127.0.0.1/sub",
			"https://10.0.0.1/sub",
			"https://192.168.1.1/sub",
			"https://[::1]/sub",
		]) {
			expect(() => validateUpstreamUrl(url)).toThrowError();
		}
	});

	it("stops reading a response after the configured size limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))),
		);
		await expect(fetchText("https://large.example/sub")).rejects.toMatchObject({
			code: "upstream_response_too_large",
		});
	});

	it("rejects redirects to a private destination", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://127.0.0.1/private" },
				}),
			),
		);
		await expect(fetchText("https://public.example/sub")).rejects.toMatchObject({
			code: "private_upstream_url",
		});
	});
});
