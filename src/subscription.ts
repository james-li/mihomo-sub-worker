import { parse } from "yaml";
import type { SubscriptionSource } from "./config";
import { parseClashSubscription, type TaggedProxy } from "./clash";
import { decodeSubscriptionBase64, parseProtocolUrl, SUPPORTED_PROTOCOL_PATTERN } from "./protocol";

export type SubscriptionFormat = "auto" | "clash-yaml" | "uri-list" | "base64-uri-list";

export interface ParsedSubscription {
	proxies: TaggedProxy[];
	format: Exclude<SubscriptionFormat, "auto">;
	warnings: Array<{ line: number; code: string }>;
}

function tagged(proxy: ReturnType<typeof parseProtocolUrl>, source: SubscriptionSource): TaggedProxy {
	return { proxy, sourceId: source.id, tags: [...source.tags] };
}

function parseUriList(text: string, source: SubscriptionSource): ParsedSubscription {
	const proxies: TaggedProxy[] = [];
	const warnings: Array<{ line: number; code: string }> = [];
	for (const [index, rawLine] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		try {
			proxies.push(tagged(parseProtocolUrl(line), source));
		} catch (error) {
			warnings.push({ line: index + 1, code: error instanceof Error ? error.message : "invalid_protocol_url" });
		}
	}
	if (proxies.length === 0) throw new Error("no_valid_protocol_urls");
	return { proxies, format: "uri-list", warnings };
}

function looksLikeClash(text: string): boolean {
	try {
		const value = parse(text);
		return !!value && typeof value === "object" && Array.isArray((value as { proxies?: unknown }).proxies);
	} catch {
		return false;
	}
}

export function parseSubscriptionText(
	text: string,
	source: SubscriptionSource,
	requestedFormat: SubscriptionFormat = "auto",
): ParsedSubscription {
	const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
	if (!normalized) throw new Error("empty_subscription");
	if (requestedFormat === "clash-yaml" || (requestedFormat === "auto" && looksLikeClash(normalized))) {
		return { proxies: parseClashSubscription(normalized, source), format: "clash-yaml", warnings: [] };
	}
	if (requestedFormat === "base64-uri-list" || requestedFormat === "auto") {
		try {
			const decoded = decodeSubscriptionBase64(normalized);
			if (SUPPORTED_PROTOCOL_PATTERN.test(decoded.trim())) {
				const result = parseUriList(decoded, source);
				return { ...result, format: "base64-uri-list" };
			}
		} catch {
			if (requestedFormat === "base64-uri-list") throw new Error("invalid_base64_subscription");
		}
	}
	if (requestedFormat === "auto" || requestedFormat === "uri-list") return parseUriList(normalized, source);
	throw new Error("unsupported_subscription_format");
}
