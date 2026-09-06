import type { ClashProxy } from "./clash";

export class ProtocolError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}

function decodeComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new ProtocolError("invalid_uri_encoding");
	}
}

function decodeBase64(value: string): string {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		throw new ProtocolError("invalid_base64");
	}
}

function port(value: string | number | undefined): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new ProtocolError("invalid_protocol_port");
	}
	return parsed;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanParam(value: string | null): boolean {
	return /^(?:1|true|yes)$/i.test(value ?? "");
}

function nameFromUrl(url: URL, protocol: string): string {
	const fragment = decodeComponent(url.hash.replace(/^#/, ""));
	return fragment || `${protocol}-${url.hostname}:${url.port}`;
}

function applyTransport(proxy: ClashProxy, params: URLSearchParams): void {
	const network = params.get("type")?.toLowerCase();
	if (!network || network === "tcp") return;
	if (network === "ws") {
		proxy.network = "ws";
		const headers: Record<string, string> = {};
		const host = params.get("host");
		if (host) headers.Host = host;
		proxy["ws-opts"] = {
			path: params.get("path") || "/",
			...(Object.keys(headers).length ? { headers } : {}),
		};
		return;
	}
	if (network === "grpc") {
		proxy.network = "grpc";
		proxy["grpc-opts"] = {
			"grpc-service-name": params.get("serviceName") || params.get("path") || "",
		};
		return;
	}
	if (network === "http" || network === "h2") {
		proxy.network = "http";
		proxy["http-opts"] = {
			path: [params.get("path") || "/"],
			...(params.get("host") ? { headers: { Host: [params.get("host")] } } : {}),
		};
		return;
	}
	throw new ProtocolError("unsupported_transport");
}

function applyTls(proxy: ClashProxy, params: URLSearchParams): void {
	const security = params.get("security")?.toLowerCase();
	if (security === "tls" || security === "reality") proxy.tls = true;
	const sni = params.get("sni") || params.get("servername");
	if (sni) proxy.servername = sni;
	if (params.get("fp")) proxy["client-fingerprint"] = params.get("fp");
	if (params.get("alpn")) proxy.alpn = params.get("alpn")!.split(",").filter(Boolean);
	if (booleanParam(params.get("allowInsecure")) || booleanParam(params.get("insecure"))) {
		proxy["skip-cert-verify"] = true;
	}
	if (security === "reality") {
		const publicKey = params.get("pbk") || params.get("public-key");
		if (!publicKey) throw new ProtocolError("missing_reality_public_key");
		proxy["reality-opts"] = {
			"public-key": publicKey,
			...(params.get("sid") ? { "short-id": params.get("sid") } : {}),
		};
	}
}

function parseStandardUrl(raw: string, type: "trojan" | "vless"): ClashProxy {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ProtocolError("invalid_protocol_url");
	}
	const authentication = decodeComponent(url.username);
	if (!authentication || !url.hostname) throw new ProtocolError("missing_protocol_fields");
	const proxy: ClashProxy = {
		name: nameFromUrl(url, type),
		type,
		server: url.hostname,
		port: port(url.port),
		udp: true,
		...(type === "trojan"
			? { password: authentication }
			: {
					uuid: authentication,
					encryption: url.searchParams.get("encryption") || "none",
					...(url.searchParams.get("flow") ? { flow: url.searchParams.get("flow") } : {}),
				}),
	};
	applyTransport(proxy, url.searchParams);
	applyTls(proxy, url.searchParams);
	return proxy;
}

function parseVmess(raw: string): ClashProxy {
	const payload = raw.slice("vmess://".length).split("#", 1)[0];
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(decodeBase64(payload)) as Record<string, unknown>;
	} catch (error) {
		if (error instanceof ProtocolError) throw error;
		throw new ProtocolError("invalid_vmess_json");
	}
	const server = stringValue(data.add);
	const uuid = stringValue(data.id);
	if (!server || !uuid) throw new ProtocolError("missing_protocol_fields");
	const proxy: ClashProxy = {
		name: stringValue(data.ps) || `vmess-${server}:${String(data.port ?? "")}`,
		type: "vmess",
		server,
		port: port(data.port as string | number | undefined),
		uuid,
		alterId: Number(data.aid ?? 0),
		cipher: stringValue(data.scy) || "auto",
		udp: true,
	};
	const network = stringValue(data.net)?.toLowerCase();
	if (network && network !== "tcp") {
		const params = new URLSearchParams({ type: network });
		if (stringValue(data.host)) params.set("host", String(data.host));
		if (stringValue(data.path)) params.set("path", String(data.path));
		if (stringValue(data.sni)) params.set("sni", String(data.sni));
		applyTransport(proxy, params);
	}
	if (data.tls && String(data.tls).toLowerCase() !== "none") proxy.tls = true;
	if (stringValue(data.sni)) proxy.servername = data.sni as string;
	if (stringValue(data.fp)) proxy["client-fingerprint"] = data.fp as string;
	if (String(data.allowInsecure ?? "") === "1") proxy["skip-cert-verify"] = true;
	return proxy;
}

function parseShadowsocks(raw: string): ClashProxy {
	let value = raw.slice("ss://".length);
	const hashIndex = value.indexOf("#");
	const name = hashIndex >= 0 ? decodeComponent(value.slice(hashIndex + 1)) : "";
	if (hashIndex >= 0) value = value.slice(0, hashIndex);
	const queryIndex = value.indexOf("?");
	const query = queryIndex >= 0 ? new URLSearchParams(value.slice(queryIndex + 1)) : null;
	if (queryIndex >= 0) value = value.slice(0, queryIndex);
	if (!value.includes("@")) value = decodeBase64(value);
	const at = value.lastIndexOf("@");
	if (at < 0) throw new ProtocolError("invalid_ss_url");
	let credentials = value.slice(0, at);
	if (!credentials.includes(":")) credentials = decodeBase64(credentials);
	const separator = credentials.indexOf(":");
	if (separator < 1) throw new ProtocolError("invalid_ss_credentials");
	const address = value.slice(at + 1);
	const addressMatch = address.match(/^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/);
	if (!addressMatch) throw new ProtocolError("invalid_protocol_address");
	const server = addressMatch[1] || addressMatch[3];
	const proxy: ClashProxy = {
		name: name || `ss-${server}:${addressMatch[2] || addressMatch[4]}`,
		type: "ss",
		server,
		port: port(addressMatch[2] || addressMatch[4]),
		cipher: decodeComponent(credentials.slice(0, separator)),
		password: decodeComponent(credentials.slice(separator + 1)),
		udp: true,
	};
	if (query?.get("plugin")) proxy.plugin = query.get("plugin");
	return proxy;
}

function parseSsr(raw: string): ClashProxy {
	const decoded = decodeBase64(raw.slice("ssr://".length));
	const [main, query = ""] = decoded.split("/?", 2);
	const parts = main.split(":");
	if (parts.length < 6) throw new ProtocolError("invalid_ssr_url");
	const [server, rawPort, protocol, cipher, obfs, password64] = parts;
	const params = new URLSearchParams(query);
	const remarks = params.get("remarks") ? decodeBase64(params.get("remarks")!) : "";
	return {
		name: remarks || `ssr-${server}:${rawPort}`,
		type: "ssr",
		server,
		port: port(rawPort),
		cipher,
		password: decodeBase64(password64),
		protocol,
		obfs,
		...(params.get("protoparam") ? { "protocol-param": decodeBase64(params.get("protoparam")!) } : {}),
		...(params.get("obfsparam") ? { "obfs-param": decodeBase64(params.get("obfsparam")!) } : {}),
		udp: true,
	};
}

function parseHysteria2(raw: string): ClashProxy {
	const normalized = raw.replace(/^hy2:\/\//i, "hysteria2://");
	let url: URL;
	try { url = new URL(normalized); } catch { throw new ProtocolError("invalid_protocol_url"); }
	const password = decodeComponent(url.username || url.password);
	if (!password || !url.hostname) throw new ProtocolError("missing_protocol_fields");
	return {
		name: nameFromUrl(url, "hysteria2"), type: "hysteria2", server: url.hostname,
		port: port(url.port), password,
		...(url.searchParams.get("sni") ? { sni: url.searchParams.get("sni") } : {}),
		...(url.searchParams.get("obfs") ? { obfs: url.searchParams.get("obfs") } : {}),
		...(url.searchParams.get("obfs-password") ? { "obfs-password": url.searchParams.get("obfs-password") } : {}),
		...(booleanParam(url.searchParams.get("insecure")) ? { "skip-cert-verify": true } : {}),
	};
}

function parseTuic(raw: string): ClashProxy {
	let url: URL;
	try { url = new URL(raw); } catch { throw new ProtocolError("invalid_protocol_url"); }
	const uuid = decodeComponent(url.username);
	const password = decodeComponent(url.password);
	if (!uuid || !password || !url.hostname) throw new ProtocolError("missing_protocol_fields");
	return {
		name: nameFromUrl(url, "tuic"), type: "tuic", server: url.hostname,
		port: port(url.port), uuid, password,
		...(url.searchParams.get("sni") ? { sni: url.searchParams.get("sni") } : {}),
		...(url.searchParams.get("alpn") ? { alpn: url.searchParams.get("alpn")!.split(",") } : {}),
		...(url.searchParams.get("congestion_control") ? { "congestion-controller": url.searchParams.get("congestion_control") } : {}),
		udp: true,
	};
}

export const SUPPORTED_PROTOCOL_PATTERN = /^(?:trojan|vless|vmess|ss|ssr|hysteria2|hy2|tuic):\/\//i;

export function parseProtocolUrl(raw: string): ClashProxy {
	const value = raw.trim();
	if (!value || /[\r\n\0]/.test(value)) throw new ProtocolError("invalid_protocol_url");
	const separator = value.indexOf(":");
	if (separator < 1) throw new ProtocolError("invalid_protocol_url");
	const scheme = value.slice(0, separator).toLowerCase();
	switch (scheme) {
		case "trojan": return parseStandardUrl(value, "trojan");
		case "vless": return parseStandardUrl(value, "vless");
		case "vmess": return parseVmess(value);
		case "ss": return parseShadowsocks(value);
		case "ssr": return parseSsr(value);
		case "hysteria2":
		case "hy2": return parseHysteria2(value);
		case "tuic": return parseTuic(value);
		default: throw new ProtocolError("unsupported_protocol");
	}
}

export function decodeSubscriptionBase64(value: string): string {
	return decodeBase64(value.replace(/\s+/g, ""));
}
