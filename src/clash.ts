import { Document, isMap, isScalar, isSeq, parse, Scalar } from "yaml";
import type { SubscriptionSource } from "./config";

export type ClashProxy = Record<string, unknown> & {
	name: string;
	type: string;
	server: string;
	port: number | string;
};

export interface TaggedProxy {
	proxy: ClashProxy;
	tags: string[];
	sourceId: string;
}

export const DEFAULT_FILTER_SITE = [
	"剩余流量",
	"流量剩余",
	"套餐到期",
	"套餐过期",
	"订阅到期",
	"订阅过期",
	"到期时间",
	"到期日期",
	"过期时间",
	"过期日期",
	"traffic remaining",
	"traffic left",
	"quota remaining",
	"quota left",
	"remaining traffic",
	"left traffic",
	"remaining quota",
	"left quota",
].join(":");

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseClashSubscription(
	text: string,
	source: SubscriptionSource,
): TaggedProxy[] {
	let document: unknown;
	try {
		document = parse(text);
	} catch {
		throw new Error("invalid_clash_yaml");
	}
	if (!isObject(document) || !Array.isArray(document.proxies)) {
		throw new Error("missing_clash_proxies");
	}
	return document.proxies
		.filter(isObject)
		.filter(
			(proxy) =>
				typeof proxy.name === "string" &&
				typeof proxy.type === "string" &&
				typeof proxy.server === "string" &&
				(typeof proxy.port === "number" || typeof proxy.port === "string"),
		)
		.map((proxy) => ({
			proxy: proxy as ClashProxy,
			tags: [...source.tags],
			sourceId: source.id,
		}));
}

function hasRequiredAuthentication(proxy: ClashProxy): boolean {
	const type = proxy.type.toLowerCase();
	if (["vmess", "vless"].includes(type)) return typeof proxy.uuid === "string";
	if (["ss", "ssr", "trojan", "hysteria2"].includes(type)) {
		return typeof proxy.password === "string";
	}
	if (type === "tuic") {
		return typeof proxy.uuid === "string" || typeof proxy.password === "string";
	}
	return true;
}

function isValidProxy(proxy: ClashProxy): boolean {
	const port = Number(proxy.port);
	return (
		proxy.name.trim().length > 0 &&
		proxy.type.trim().length > 0 &&
		proxy.server.trim().length > 0 &&
		Number.isInteger(port) &&
		port > 0 &&
		port <= 65535 &&
		hasRequiredAuthentication(proxy)
	);
}

function normalizedFilterText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "");
}

function filterSiteKeywords(filterSite?: string): string[] {
	const configured = filterSite?.trim() ? filterSite : DEFAULT_FILTER_SITE;
	return [...new Set(
		configured
			.split(":")
			.map(normalizedFilterText)
			.filter(Boolean),
	)];
}

function isInformationProxy(proxy: ClashProxy, keywords: string[]): boolean {
	const name = normalizedFilterText(proxy.name);
	return keywords.some((keyword) => name.includes(keyword));
}

async function fingerprint(proxy: ClashProxy): Promise<string> {
	const identity = JSON.stringify([
		proxy.type.toLowerCase(),
		proxy.server.toLowerCase(),
		Number(proxy.port),
		proxy.uuid ?? null,
		proxy.password ?? null,
		proxy["private-key"] ?? null,
		proxy.token ?? null,
	]);
	const hash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
	);
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function cleanProxies(
	items: TaggedProxy[],
	visibility: "admin" | "user",
	filterSite?: string,
): Promise<TaggedProxy[]> {
	const excludedKeywords = filterSiteKeywords(filterSite);
	const deduplicated = new Map<string, TaggedProxy>();
	for (const item of items) {
		if (!isValidProxy(item.proxy)) continue;
		if (isInformationProxy(item.proxy, excludedKeywords)) continue;
		if (visibility === "user" && item.tags.includes("PRIVATE")) continue;
		const key = await fingerprint(item.proxy);
		const existing = deduplicated.get(key);
		if (existing) {
			existing.tags = [...new Set([...existing.tags, ...item.tags])];
			continue;
		}
		deduplicated.set(key, { ...item, tags: [...item.tags], proxy: { ...item.proxy } });
	}

	const nameCounts = new Map<string, number>();
	const usedNames = new Set<string>();
	for (const item of deduplicated.values()) {
		const tagSuffix = [...new Set(item.tags)].map((tag) => `[${tag}]`).join(" ");
		const baseName = tagSuffix ? `${item.proxy.name} ${tagSuffix}` : item.proxy.name;
		let count = nameCounts.get(baseName) ?? 1;
		let candidate = baseName;
		while (usedNames.has(candidate)) {
			count += 1;
			candidate = `${baseName} · ${count}`;
		}
		nameCounts.set(baseName, count);
		item.proxy.name = candidate;
		usedNames.add(candidate);
	}
	return [...deduplicated.values()];
}

export interface ClashOutput {
	port: number;
	"socks-port": number;
	"allow-lan": boolean;
	mode: string;
	"log-level": string;
	"external-controller": string;
	proxies: ClashProxy[];
	"proxy-groups": Array<Record<string, unknown>>;
	rules: string[];
}

function quoteFlowStringValues(node: unknown): void {
	if (isScalar(node)) {
		if (typeof node.value === "string") node.type = Scalar.QUOTE_DOUBLE;
		return;
	}
	if (isMap(node)) {
		for (const pair of node.items) quoteFlowStringValues(pair.value);
		return;
	}
	if (isSeq(node)) {
		for (const item of node.items) quoteFlowStringValues(item);
	}
}

export function renderClash(
	proxies: TaggedProxy[],
	groups: Array<Record<string, unknown>>,
	rules: string[],
): string {
	const output: ClashOutput = {
		port: 7890,
		"socks-port": 7891,
		"allow-lan": true,
		mode: "Rule",
		"log-level": "info",
		"external-controller": "127.0.0.1:9090",
		proxies: proxies.map((item) => item.proxy),
		"proxy-groups": groups,
		rules,
	};
	const document = new Document(output);
	const proxyNodes = document.get("proxies", true);
	if (isSeq(proxyNodes)) {
		for (const proxyNode of proxyNodes.items) {
			if (isMap(proxyNode)) {
				proxyNode.flow = true;
				quoteFlowStringValues(proxyNode);
			}
		}
	}
	return document.toString({ flowCollectionPadding: false, lineWidth: 0 });
}
