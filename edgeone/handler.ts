import worker from "../src/index";
import type { AppEnv, ConfigKV } from "../src/env";

interface EdgeOneEventContext {
	request: Request;
	env: Record<string, string | undefined>;
}

declare const CONFIG_KV: ConfigKV;

export async function onRequest(context: EdgeOneEventContext): Promise<Response> {
	const env: AppEnv = {
		CONFIG_KV,
		ADMIN_KEY: context.env.ADMIN_KEY ?? "",
		USER_KEY: context.env.USER_KEY ?? "",
		ACC4SSR_INI: context.env.ACC4SSR_INI ?? "",
		FILTER_SITE: context.env.FILTER_SITE,
	};
	return worker.fetch(context.request, env);
}
