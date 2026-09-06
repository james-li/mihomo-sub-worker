import type { AppEnv } from "./env";
import { validateUpstreamUrl } from "./upstream";
import { parseProtocolUrl } from "./protocol";
import { parseSubscriptionText } from "./subscription";

export const CONFIG_KEY = "config_current";
export const MAX_SOURCES = 10;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CONFIG_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export type SourceType = "url" | "file" | "protocol_url";
export type SourceFormat = "auto" | "clash-yaml" | "uri-list" | "base64-uri-list";

export interface SubscriptionSource {
	id: string;
	type?: SourceType;
	name?: string;
	tags: string[];
	enabled: boolean;
	format?: SourceFormat;
	url?: string;
	fileName?: string;
	content?: string;
	size?: number;
	sha256?: string;
	protocolUrl?: string;
	protocol?: string;
}

export interface AppConfig {
	version: number;
	updatedAt: string;
	sources: SubscriptionSource[];
}

interface SourceInput {
	id?: unknown;
	type?: unknown;
	name?: unknown;
	url?: unknown;
	fileName?: unknown;
	content?: unknown;
	format?: unknown;
	protocolUrl?: unknown;
	tags?: unknown;
	enabled?: unknown;
}

interface ConfigInput {
	version?: unknown;
	sources?: unknown;
}

export class ConfigError extends Error {
	constructor(
		public readonly code: string,
		public readonly status = 400,
	) {
		super(code);
	}
}

export function defaultConfig(): AppConfig {
	return { version: 0, updatedAt: "1970-01-01T00:00:00.000Z", sources: [] };
}

function normalizeTags(hash: string, input?: unknown): string[] {
	const explicit = Array.isArray(input) ? input.filter((tag): tag is string => typeof tag === "string") : [];
	return [
		...new Set(
			[...decodeURIComponent(hash.replace(/^#/, "")).split("_"), ...explicit]
				.map((tag) => tag.trim().toUpperCase())
				.filter(Boolean),
		),
	];
}

function normalizeFormat(value: unknown): SourceFormat {
	return ["auto", "clash-yaml", "uri-list", "base64-uri-list"].includes(String(value))
		? (value as SourceFormat)
		: "auto";
}

function normalizeName(value: unknown): string | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string" || value.length > 120) throw new ConfigError("invalid_source_name");
	return value.trim() || undefined;
}

function sourceId(value: unknown): string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
		? value
		: crypto.randomUUID();
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function normalizeSource(input: SourceInput): Promise<SubscriptionSource> {
	const type = (input.type ?? (input.url !== undefined ? "url" : undefined)) as SourceType | undefined;
	const base = {
		id: sourceId(input.id),
		type: type as SourceType,
		name: normalizeName(input.name),
		tags: [] as string[],
		enabled: input.enabled !== false,
	};

	if (type === "file") {
		if (typeof input.content !== "string") throw new ConfigError("invalid_file_content");
		const size = new TextEncoder().encode(input.content).byteLength;
		if (size === 0) throw new ConfigError("empty_file_content");
		if (size > MAX_FILE_BYTES) throw new ConfigError("file_too_large", 413);
		const fileName = typeof input.fileName === "string"
			? input.fileName.replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 120)
			: "subscription.txt";
		const source: SubscriptionSource = {
			...base,
			type,
			tags: normalizeTags("", input.tags),
			fileName: fileName || "subscription.txt",
			content: input.content,
			size,
			sha256: await sha256(input.content),
			format: normalizeFormat(input.format),
		};
		try {
			const parsed = parseSubscriptionText(source.content ?? "", source, source.format);
			if (parsed.proxies.length > 2000) throw new Error("too_many_source_nodes");
		} catch (error) {
			throw new ConfigError(error instanceof Error ? error.message : "invalid_file_content");
		}
		return source;
	}

	if (type === "protocol_url") {
		if (typeof input.protocolUrl !== "string" || input.protocolUrl.length > 16 * 1024) {
			throw new ConfigError("invalid_protocol_url");
		}
		const protocolUrl = input.protocolUrl.trim();
		if (!protocolUrl || /[\r\n\0]/.test(protocolUrl)) throw new ConfigError("invalid_protocol_url");
		const protocol = protocolUrl.slice(0, protocolUrl.indexOf(":")).toLowerCase();
		if (!["trojan", "vless", "vmess", "ss", "ssr", "hysteria2", "hy2", "tuic"].includes(protocol)) {
			throw new ConfigError("unsupported_protocol");
		}
		try {
			parseProtocolUrl(protocolUrl);
		} catch (error) {
			throw new ConfigError(error instanceof Error ? error.message : "invalid_protocol_url");
		}
		return { ...base, type, tags: normalizeTags("", input.tags), protocolUrl, protocol };
	}

	if (type !== "url" || typeof input.url !== "string" || input.url.length > 4096) {
		throw new ConfigError("invalid_source_url");
	}

	let parsed: URL;
	try {
		parsed = new URL(input.url);
	} catch {
		throw new ConfigError("invalid_source_url");
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
		throw new ConfigError("invalid_source_url");
	}

	let tags: string[];
	try {
		tags = normalizeTags(parsed.hash, input.tags);
	} catch {
		throw new ConfigError("invalid_source_tags");
	}
	parsed.hash = "";
	try {
		parsed = validateUpstreamUrl(parsed.toString());
	} catch {
		throw new ConfigError("invalid_source_url");
	}

	return {
		...base,
		type,
		url: parsed.toString(),
		tags,
		format: normalizeFormat(input.format),
	};
}

function isStoredConfig(value: unknown): value is AppConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as Partial<AppConfig>;
	return (
		Number.isInteger(config.version) &&
		(config.version ?? -1) >= 0 &&
		typeof config.updatedAt === "string" &&
		Array.isArray(config.sources)
	);
}

export async function loadConfig(env: AppEnv): Promise<AppConfig> {
	const stored = await env.CONFIG_KV.get<unknown>(CONFIG_KEY, { type: "json" });
	if (stored === null) return defaultConfig();
	if (!isStoredConfig(stored)) throw new Error("Stored configuration is invalid");
	return {
		...stored,
		sources: stored.sources.map((source) => ({
			...source,
			type: source.type ?? "url",
			format: source.format ?? "auto",
		})),
	};
}

export async function parseConfigInput(value: unknown): Promise<{
	version: number;
	sources: SubscriptionSource[];
}> {
	if (!value || typeof value !== "object") throw new ConfigError("invalid_config");
	const input = value as ConfigInput;
	if (!Number.isInteger(input.version) || (input.version as number) < 0) {
		throw new ConfigError("invalid_config_version");
	}
	if (!Array.isArray(input.sources)) throw new ConfigError("invalid_sources");
	if (input.sources.length > MAX_SOURCES) {
		throw new ConfigError("too_many_sources", 413);
	}

	const sources = await Promise.all(input.sources.map((source) => normalizeSource(source as SourceInput)));
	const ids = new Set(sources.map((source) => source.id));
	if (ids.size !== sources.length) throw new ConfigError("duplicate_source_id");
	return { version: input.version as number, sources };
}

export async function saveConfig(
	env: AppEnv,
	input: { version: number; sources: SubscriptionSource[] },
): Promise<AppConfig> {
	const current = await loadConfig(env);
	if (current.version !== input.version) {
		throw new ConfigError("config_version_conflict", 409);
	}
	const next: AppConfig = {
		version: current.version + 1,
		updatedAt: new Date().toISOString(),
		sources: input.sources,
	};
	const serialized = JSON.stringify(next);
	if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIG_BYTES) {
		throw new ConfigError("config_too_large", 413);
	}
	await env.CONFIG_KV.put(CONFIG_KEY, serialized);
	return next;
}
