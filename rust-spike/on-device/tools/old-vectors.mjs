// Makes reference vectors with the legacy app's own recipe (packages/memory/src/
// local-embedding-provider.ts): transformers.js feature extraction, 512-token cap, mean pooling,
// normalised, prefix per kind. Usage: node old-vectors.mjs <transformers-package-dir> <cache-dir>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, cacheDir] = process.argv.slice(2);
const { env, pipeline } = await import(
  pathToFileURL(join(packageDir, "src", "transformers.js")).href
);
env.cacheDir = cacheDir;
const pipe = await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5");
pipe.tokenizer.model_max_length = 512;
const sentences = JSON.parse(readFileSync(new URL("../fixtures/sentences.json", import.meta.url)));
const out = [];
for (const { kind, text } of sentences) {
  const prefix = kind === "query" ? "search_query" : "search_document";
  const o = await pipe(`${prefix}: ${text}`, { pooling: "mean", normalize: true });
  out.push(Array.from(o.data));
}
writeFileSync(new URL("../fixtures/old-vectors.json", import.meta.url), JSON.stringify(out));
console.log("vectors", out.length, "dims", out[0].length);
