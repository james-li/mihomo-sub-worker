import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

process.env.ADMIN_KEY ??= "test-admin-key";
process.env.USER_KEY ??= "test-user-key";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					ADMIN_KEY: "test-admin-key",
					USER_KEY: "test-user-key",
					ACC4SSR_INI: "https://example.com/acl.ini",
				},
				kvNamespaces: ["CONFIG_KV"],
			},
		}),
	],
});
