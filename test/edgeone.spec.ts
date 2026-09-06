import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../edgeone/handler";
import { CONFIG_KEY } from "../src/config";
import type { ConfigKV } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

describe("EdgeOne entrypoint", () => {
	it("maps Pages environment variables and the global KV binding", async () => {
		const stored = JSON.stringify({
			version: 7,
			updatedAt: "2026-09-06T00:00:00.000Z",
			sources: [],
		});
		const get = vi.fn(async (key: string) => key === CONFIG_KEY ? JSON.parse(stored) : null);
		const kv = { get, put: vi.fn(async () => undefined) } as unknown as ConfigKV;
		vi.stubGlobal("CONFIG_KV", kv);

		const response = await onRequest({
			request: new Request("https://fgfwsub.cloudintel.com.cn/admin/api/config"),
			env: {
				ADMIN_KEY: "admin",
				USER_KEY: "user",
				ACC4SSR_INI: "https://example.com/acl.ini",
				FILTER_SITE: "剩余流量:套餐到期",
			},
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ version: 7, sources: [] });
		expect(get).toHaveBeenCalledWith(CONFIG_KEY, { type: "json" });
	});
});
