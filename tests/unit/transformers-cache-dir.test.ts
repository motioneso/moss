import { describe, expect, it } from "vitest";

import { applyTransformersCacheDir } from "../../packages/memory/src/transformers-cache-dir.js";

describe("applyTransformersCacheDir", () => {
  it("redirects the model cache under HF_HOME when the deployment sets one", () => {
    const env = { cacheDir: "/app/node_modules/@huggingface/transformers/.cache/" };
    applyTransformersCacheDir(env, "/app/.cache/huggingface");
    expect(env.cacheDir).toBe("/app/.cache/huggingface/transformers");
  });

  it("leaves the library default alone when HF_HOME is unset", () => {
    const env = { cacheDir: "/somewhere/.cache/" };
    applyTransformersCacheDir(env, undefined);
    expect(env.cacheDir).toBe("/somewhere/.cache/");
  });

  it("treats an empty HF_HOME as unset rather than writing to the filesystem root", () => {
    const env = { cacheDir: "/somewhere/.cache/" };
    applyTransformersCacheDir(env, "");
    expect(env.cacheDir).toBe("/somewhere/.cache/");
  });
});
