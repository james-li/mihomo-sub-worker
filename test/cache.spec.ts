import { afterEach, describe, expect, it, vi } from "vitest";
import { readCache, writeCache } from "../src/cache";
import { fetchTextCached } from "../src/upstream";

afterEach(() => vi.unstubAllGlobals());

describe("Cache API helpers", () => {
	it("round-trips JSON without using KV", async () => {
		await writeCache("test-json", "identity-1", { ok: true }, 60);
		expect(await readCache("test-json", "identity-1")).toEqual({ ok: true });
	});

	it("uses stale upstream content when refresh fails", async () => {
		const url = "https://stale-cache.example/sub";
		await writeCache(
			"upstream-subscription",
			url,
			{ text: "cached subscription", fetchedAt: Date.now() - 10 * 60 * 1000 },
			1800,
		);
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("offline");
		}));
		expect(await fetchTextCached(url, "subscription")).toEqual({
			text: "cached subscription",
			stale: true,
		});
	});
});
