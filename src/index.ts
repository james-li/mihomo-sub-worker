import { identifyRole } from "./auth";
import { readCache, writeCache } from "./cache";
import {
	ConfigError,
	MAX_CONFIG_BODY_BYTES,
	loadConfig,
	parseConfigInput,
	saveConfig,
} from "./config";
import { assertValidEnv, type AppEnv } from "./env";
import { generateSubscription, GenerationError } from "./generate";
import { errorResponse, jsonResponse, methodNotAllowed } from "./http";
import { createQrSvg } from "./qr";
import { ADMIN_APP_JS, adminHtml } from "./ui";

const OUTPUT_FORMAT_VERSION = "2";

function adminPageResponse(pathname: string): Response {
	const scriptPath = `${pathname.replace(/\/$/, "")}/app.js`;
	return new Response(adminHtml(scriptPath), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

async function clashResponse(
	env: AppEnv,
	visibility: "admin" | "user",
): Promise<Response> {
	try {
		const config = await loadConfig(env);
		const cacheIdentity = `${OUTPUT_FORMAT_VERSION}:${visibility}:${config.version}`;
		let result = await readCache<Awaited<ReturnType<typeof generateSubscription>>>(
			"generated",
			cacheIdentity,
		);
		if (!result) {
			result = await generateSubscription(env, config, visibility);
			try {
				await writeCache("generated", cacheIdentity, result, 60);
			} catch {
				// Cache API is best-effort and does not affect response correctness.
			}
		}
		const headers = new Headers({
			"content-type": "text/yaml; charset=utf-8",
			"content-disposition": 'attachment; filename="clash.yml"',
			"cache-control": "private, max-age=60",
			"x-content-type-options": "nosniff",
			"x-fgfwsub-node-count": String(result.nodes),
		});
		if (result.partial) {
			headers.set("x-fgfwsub-partial", "1");
			headers.set("x-fgfwsub-failed-sources", String(result.failedSources));
		}
		return new Response(result.yaml, { headers });
	} catch (error) {
		if (error instanceof GenerationError) {
			return errorResponse(502, error.code);
		}
		console.error({
			event: "subscription_generation_failed",
			message: error instanceof Error ? error.message : "unknown_error",
		});
		return errorResponse(502, "subscription_generation_failed");
	}
}

async function readJsonBody(request: Request): Promise<unknown> {
	const declaredLength = Number(request.headers.get("content-length") ?? 0);
	if (declaredLength > MAX_CONFIG_BODY_BYTES) {
		throw new ConfigError("config_body_too_large", 413);
	}
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_CONFIG_BODY_BYTES) {
		throw new ConfigError("config_body_too_large", 413);
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new ConfigError("invalid_json");
	}
}

function wantsClash(request: Request, url: URL): boolean {
	if (url.searchParams.get("format") === "clash") return true;
	return /clash|mihomo/i.test(request.headers.get("user-agent") ?? "");
}

async function handleAdminApi(
	request: Request,
	env: AppEnv,
	subpath: string,
): Promise<Response> {
	if (subpath === "app.js") {
		if (request.method !== "GET") return methodNotAllowed(["GET"]);
		return new Response(ADMIN_APP_JS, {
			headers: {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			},
		});
	}
	if (subpath === "api/config") {
		if (request.method === "GET") return jsonResponse(await loadConfig(env));
		if (request.method === "PUT") {
			try {
				const input = await parseConfigInput(await readJsonBody(request));
				return jsonResponse(await saveConfig(env, input));
			} catch (error) {
				if (error instanceof ConfigError) {
					return errorResponse(error.status, error.code);
				}
				throw error;
			}
		}
		return methodNotAllowed(["GET", "PUT"]);
	}
	if (subpath === "api/status") {
		if (request.method !== "GET") return methodNotAllowed(["GET"]);
		const config = await loadConfig(env);
		return jsonResponse({
			version: config.version,
			updatedAt: config.updatedAt,
			sources: config.sources.length,
			enabledSources: config.sources.filter((source) => source.enabled).length,
			sourceDetails: config.sources,
		});
	}
	if (subpath === "api/subscription-qr.svg") {
		if (request.method !== "GET") return methodNotAllowed(["GET"]);
		const subscriptionUrl = `${new URL(request.url).origin}/${encodeURIComponent(env.USER_KEY)}`;
		return new Response(createQrSvg(subscriptionUrl), {
			headers: {
				"content-type": "image/svg+xml; charset=utf-8",
				"content-disposition": 'inline; filename="fgfwsub-user-qr.svg"',
				"cache-control": "no-store",
				"content-security-policy": "default-src 'none'; sandbox",
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
			},
		});
	}
	if (subpath === "api/preview") {
		if (request.method !== "POST") return methodNotAllowed(["POST"]);
		try {
			const result = await generateSubscription(env, await loadConfig(env), "admin");
			return jsonResponse({
				nodes: result.nodes,
				partial: result.partial,
				failedSources: result.failedSources,
				warnings: result.warnings,
				sites: result.sites,
			});
		} catch (error) {
			return errorResponse(
				502,
				error instanceof GenerationError
					? error.code
					: "subscription_generation_failed",
			);
		}
	}
	return errorResponse(404, "not_found");
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			assertValidEnv(env);
			const url = new URL(request.url);
			const segments = url.pathname.split("/").filter(Boolean);
			if (segments.length === 0) return errorResponse(404, "not_found");

			let key: string;
			try {
				key = decodeURIComponent(segments[0]);
			} catch {
				return errorResponse(404, "not_found");
			}
			const role = await identifyRole(key, env);
			if (role === null) return errorResponse(404, "not_found");

			if (role === "user") {
				if (segments.length !== 1) return errorResponse(404, "not_found");
				if (request.method !== "GET") return methodNotAllowed(["GET"]);
				return clashResponse(env, "user");
			}

			const subpath = segments.slice(1).join("/");
			if (subpath) return handleAdminApi(request, env, subpath);
			if (request.method !== "GET") return methodNotAllowed(["GET"]);
			return wantsClash(request, url)
				? clashResponse(env, "admin")
				: adminPageResponse(url.pathname);
		} catch (error) {
			console.error({ event: "request_failed", message: (error as Error).message });
			return errorResponse(500, "internal_error");
		}
	},
} satisfies ExportedHandler<AppEnv>;
