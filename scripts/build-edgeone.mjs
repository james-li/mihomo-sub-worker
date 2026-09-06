import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("edge-functions", { recursive: true });
await mkdir("edgeone-dist", { recursive: true });

await build({
	entryPoints: ["edgeone/handler.ts"],
	outfile: "edge-functions/[[default]].js",
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	legalComments: "none",
});

await writeFile(
	"edgeone-dist/404.html",
	"<!doctype html><meta charset=\"utf-8\"><title>Not Found</title><h1>404 Not Found</h1>\n",
);
