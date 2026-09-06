import { compileAcl, parseAclIni } from "./acl";
import { deleteCache } from "./cache";
import { cleanProxies, renderClash, type ClashProxy, type TaggedProxy } from "./clash";
import { mapConcurrent } from "./concurrency";
import type { AppConfig, SubscriptionSource } from "./config";
import type { AppEnv } from "./env";
import { fetchTextCached } from "./upstream";
import { parseProtocolUrl } from "./protocol";
import { parseSubscriptionText } from "./subscription";

const MAX_NODES = 2000;

function checkedProxies(proxies: TaggedProxy[]): TaggedProxy[] {
	if (proxies.length > MAX_NODES) throw new Error("too_many_source_nodes");
	return proxies;
}

interface SourceResult {
	source: SubscriptionSource;
	proxies: TaggedProxy[];
	error?: string;
	stale?: boolean;
	warnings?: number;
}

export class GenerationError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}

async function loadSource(source: SubscriptionSource): Promise<SourceResult> {
	if (source.type === "file") {
		try {
			const parsed = parseSubscriptionText(source.content ?? "", source, source.format ?? "auto");
			return { source, proxies: checkedProxies(parsed.proxies), warnings: parsed.warnings.length };
		} catch (error) {
			return { source, proxies: [], error: error instanceof Error ? error.message : "source_failed" };
		}
	}
	if (source.type === "protocol_url") {
		try {
			const proxy = parseProtocolUrl(source.protocolUrl ?? "");
			if (source.name?.trim()) proxy.name = source.name.trim();
			return {
				source,
				proxies: checkedProxies([{ proxy, sourceId: source.id, tags: [...source.tags] }]),
			};
		} catch (error) {
			return { source, proxies: [], error: error instanceof Error ? error.message : "source_failed" };
		}
	}
	if (!source.url) return { source, proxies: [], error: "invalid_source_url" };
	try {
		const result = await fetchTextCached(source.url, "subscription");
		try {
			const parsed = parseSubscriptionText(result.text, source, source.format ?? "auto");
			return {
				source,
				proxies: checkedProxies(parsed.proxies),
				stale: result.stale,
				warnings: parsed.warnings.length,
			};
		} catch (error) {
			await deleteCache("upstream-subscription", new URL(source.url).toString());
			throw error;
		}
	} catch (error) {
		return {
			source,
			proxies: [],
			error: error instanceof Error ? error.message : "source_failed",
		};
	}
}

export interface GenerationResult {
	yaml: string;
	partial: boolean;
	failedSources: number;
	nodes: number;
	warnings: number;
	sites: ClashProxy[];
}

export async function generateSubscription(
	env: AppEnv,
	config: AppConfig,
	visibility: "admin" | "user",
): Promise<GenerationResult> {
	const enabledSources = config.sources.filter((source) => source.enabled);
	const sourceResults = await mapConcurrent(enabledSources, 4, loadSource);
	const unavailableSources = sourceResults.filter((result) => result.error).length;
	const failedSources = sourceResults.filter(
		(result) => result.error || result.stale,
	).length;
	if (enabledSources.length > 0 && unavailableSources === enabledSources.length) {
		throw new GenerationError("all_subscription_sources_failed");
	}
	const tagged = sourceResults.flatMap((result) => result.proxies);
	const proxies = await cleanProxies(tagged, visibility);
	if (proxies.length > MAX_NODES) throw new GenerationError("too_many_nodes");
	if (enabledSources.length === 0) {
		return {
			yaml: renderClash(proxies, [], []),
			partial: false,
			failedSources: 0,
			nodes: 0,
			warnings: 0,
			sites: [],
		};
	}
	const aclResult = await fetchTextCached(env.ACC4SSR_INI, "acl");
	let aclDefinition: ReturnType<typeof parseAclIni>;
	try {
		aclDefinition = parseAclIni(aclResult.text);
	} catch (error) {
		await deleteCache("upstream-acl", new URL(env.ACC4SSR_INI).toString());
		throw error;
	}
	const acl = await compileAcl(aclDefinition, proxies);
	return {
		yaml: renderClash(proxies, acl.groups, acl.rules),
		partial: failedSources > 0,
		failedSources,
		nodes: proxies.length,
		warnings: sourceResults.reduce((count, result) => count + (result.warnings ?? 0), 0),
		sites: proxies.map((item) => item.proxy),
	};
}
