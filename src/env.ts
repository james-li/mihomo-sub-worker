export interface AppEnv {
	CONFIG_KV: KVNamespace;
	ADMIN_KEY: string;
	USER_KEY: string;
	ACC4SSR_INI: string;
}

export function assertValidEnv(env: AppEnv): void {
	if (!env.ADMIN_KEY || !env.USER_KEY || !env.ACC4SSR_INI) {
		throw new Error("Required Worker configuration is missing");
	}
	if (env.ADMIN_KEY === env.USER_KEY) {
		throw new Error("ADMIN_KEY and USER_KEY must be different");
	}
}
