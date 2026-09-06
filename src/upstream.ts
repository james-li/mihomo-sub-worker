import { readCache, writeCache } from "./cache";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;

export class UpstreamError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
		return false;
	}
	const bytes = parts.map(Number);
	if (bytes.some((byte) => byte > 255)) return true;
	return (
		bytes[0] === 10 ||
		bytes[0] === 127 ||
		(bytes[0] === 169 && bytes[1] === 254) ||
		(bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
		(bytes[0] === 192 && bytes[1] === 168) ||
		bytes[0] === 0
	);
}

export function validateUpstreamUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new UpstreamError("invalid_upstream_url");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new UpstreamError("invalid_upstream_url");
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname === "::1" ||
		hostname.startsWith("fc") ||
		hostname.startsWith("fd") ||
		hostname.startsWith("fe8") ||
		hostname.startsWith("fe9") ||
		hostname.startsWith("fea") ||
		hostname.startsWith("feb") ||
		isPrivateIpv4(hostname)
	) {
		throw new UpstreamError("private_upstream_url");
	}
	url.hash = "";
	return url;
}

async function responseTextWithLimit(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length") ?? 0);
	if (declaredLength > MAX_RESPONSE_BYTES) {
		throw new UpstreamError("upstream_response_too_large");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalLength += value.byteLength;
		if (totalLength > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new UpstreamError("upstream_response_too_large");
		}
		chunks.push(value);
	}
	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

export async function fetchText(input: string): Promise<string> {
	let url = validateUpstreamUrl(input);
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		let response: Response;
		try {
			response = await fetch(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					accept: "text/yaml, text/plain, application/yaml, */*",
					"user-agent": "fgfwsub-worker/0.1",
				},
			});
		} catch {
			throw new UpstreamError("upstream_fetch_failed");
		}

		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			if (!location || redirects === MAX_REDIRECTS) {
				throw new UpstreamError("upstream_redirect_failed");
			}
			url = validateUpstreamUrl(new URL(location, url).toString());
			continue;
		}
		if (!response.ok) throw new UpstreamError(`upstream_http_${response.status}`);
		return responseTextWithLimit(response);
	}
	throw new UpstreamError("upstream_redirect_failed");
}

interface CachedText {
	text: string;
	fetchedAt: number;
}

export interface CachedTextResult {
	text: string;
	stale: boolean;
}

export async function fetchTextCached(
	input: string,
	namespace: string,
): Promise<CachedTextResult> {
	const url = validateUpstreamUrl(input).toString();
	const cached = await readCache<CachedText>(`upstream-${namespace}`, url);
	if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
		return { text: cached.text, stale: false };
	}
	try {
		const text = await fetchText(url);
		try {
			await writeCache(
				`upstream-${namespace}`,
				url,
				{ text, fetchedAt: Date.now() } satisfies CachedText,
				30 * 60,
			);
		} catch {
			// Cache API is best-effort and must not make a successful fetch fail.
		}
		return { text, stale: false };
	} catch (error) {
		if (cached) return { text: cached.text, stale: true };
		throw error;
	}
}
