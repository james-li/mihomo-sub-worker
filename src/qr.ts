import qrcode from "qrcode-generator";

export function createQrSvg(value: string): string {
	const qr = qrcode(0, "M");
	qr.addData(value, "Byte");
	qr.make();
	return qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true });
}
