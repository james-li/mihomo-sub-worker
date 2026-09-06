import { describe, expect, it } from "vitest";
import { createQrSvg } from "../src/qr";

describe("QR code generation", () => {
	it("generates a scalable SVG without embedding the subscription URL as text", () => {
		const subscriptionUrl = "https://example.com/secret-user-key";
		const svg = createQrSvg(subscriptionUrl);
		expect(svg).toContain("<svg");
		expect(svg).toContain("viewBox=");
		expect(svg).not.toContain(subscriptionUrl);
	});
});
