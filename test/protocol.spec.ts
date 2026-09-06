import { describe, expect, it } from "vitest";
import type { SubscriptionSource } from "../src/config";
import { parseProtocolUrl } from "../src/protocol";
import { parseSubscriptionText } from "../src/subscription";

const source: SubscriptionSource = {
	id: "mixed",
	type: "file",
	tags: ["PRIVATE"],
	enabled: true,
};

function base64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	return btoa(String.fromCharCode(...bytes));
}

describe("protocol URL parsing", () => {
	it("parses VLESS Reality and WebSocket fields", () => {
		const proxy = parseProtocolUrl(
			"vless://11111111-1111-1111-1111-111111111111@example.com:443?security=reality&sni=www.example.com&fp=chrome&pbk=public-key&sid=abcd&type=ws&host=cdn.example.com&path=%2Fws#VLESS-HK",
		);
		expect(proxy).toMatchObject({
			name: "VLESS-HK",
			type: "vless",
			server: "example.com",
			port: 443,
			tls: true,
			network: "ws",
			"client-fingerprint": "chrome",
			"reality-opts": { "public-key": "public-key", "short-id": "abcd" },
		});
	});

	it("parses Trojan and VMess links", () => {
		const trojan = parseProtocolUrl("trojan://secret@example.com:443?security=tls&sni=edge.example.com#Trojan");
		expect(trojan).toMatchObject({ type: "trojan", password: "secret", servername: "edge.example.com" });

		const vmessPayload = base64(JSON.stringify({
			v: "2", ps: "VMess", add: "vm.example.com", port: "443",
			id: "22222222-2222-2222-2222-222222222222", aid: "0", scy: "auto", net: "ws", tls: "tls", path: "/v", host: "cdn.example.com",
		}));
		const vmess = parseProtocolUrl(`vmess://${vmessPayload}`);
		expect(vmess).toMatchObject({ type: "vmess", name: "VMess", port: 443, tls: true, network: "ws" });
	});

	it("parses SIP002 Shadowsocks", () => {
		const credentials = base64("aes-128-gcm:password").replace(/=+$/, "");
		const proxy = parseProtocolUrl(`ss://${credentials}@ss.example.com:8388#SS-HK`);
		expect(proxy).toMatchObject({ type: "ss", cipher: "aes-128-gcm", password: "password", port: 8388 });
	});

	it("parses plain and Base64 mixed subscriptions with warnings", () => {
		const lines = "trojan://secret@one.example.com:443#One\ninvalid line\nvless://uuid@two.example.com:8443#Two";
		const plain = parseSubscriptionText(lines, source);
		expect(plain.proxies).toHaveLength(2);
		expect(plain.warnings).toEqual([{ line: 2, code: "invalid_protocol_url" }]);
		expect(plain.proxies[0].tags).toEqual(["PRIVATE"]);

		const encoded = parseSubscriptionText(base64(lines), source);
		expect(encoded.format).toBe("base64-uri-list");
		expect(encoded.proxies).toHaveLength(2);
	});
});
