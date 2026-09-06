import type { AppEnv } from "./env";

export type Role = "admin" | "user";

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
}

async function secureEqual(left: string, right: string): Promise<boolean> {
	const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
	let difference = 0;
	for (let index = 0; index < leftHash.length; index += 1) {
		difference |= leftHash[index] ^ rightHash[index];
	}
	return difference === 0;
}

export async function identifyRole(
	key: string,
	env: AppEnv,
): Promise<Role | null> {
	const [isAdmin, isUser] = await Promise.all([
		secureEqual(key, env.ADMIN_KEY),
		secureEqual(key, env.USER_KEY),
	]);
	if (isAdmin) return "admin";
	if (isUser) return "user";
	return null;
}
