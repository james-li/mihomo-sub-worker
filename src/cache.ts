const INTERNAL_CACHE_ORIGIN = "https://cache.fgfwsub.invalid";

async function sha256(value: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cacheRequest(namespace: string, identity: string): Promise<Request> {
	return new Request(
		`${INTERNAL_CACHE_ORIGIN}/${encodeURIComponent(namespace)}/${await sha256(identity)}`,
	);
}

export async function readCache<T>(
	namespace: string,
	identity: string,
): Promise<T | null> {
	let response: Response | undefined;
	try {
		response = await caches.default.match(await cacheRequest(namespace, identity));
	} catch {
		return null;
	}
	if (!response) return null;
	try {
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

export async function deleteCache(
	namespace: string,
	identity: string,
): Promise<void> {
	try {
		await caches.default.delete(await cacheRequest(namespace, identity));
	} catch {
		// Cache API is best-effort.
	}
}

export async function writeCache(
	namespace: string,
	identity: string,
	value: unknown,
	ttlSeconds: number,
): Promise<void> {
	const response = Response.json(value, {
		headers: { "cache-control": `public, max-age=${ttlSeconds}` },
	});
	await caches.default.put(await cacheRequest(namespace, identity), response);
}
