import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readSource, validateSource } from "./source.mjs";

const source = { files: [{ path: "src/worker/index.ts", content: "export {};" }] };

test("source input is bounded plain data with canonical, unique paths", async () => {
  assert.deepEqual(await readSource(Readable.from([JSON.stringify(source)])), source);
  for (const path of [
    "../escape.ts",
    "/tmp/escape.ts",
    "src/web/../escape.ts",
    "src\\web\\x.ts",
    "src/web//x.ts",
    "package.json",
    "tsconfig.json",
    ".claude/settings.json",
    "dist/worker.js"
  ]) {
    assert.throws(() => validateSource({ files: [{ path, content: "x" }] }));
  }
  for (const value of [
    { ...source, command: "anything" },
    { files: [source.files[0], source.files[0]] },
    { files: [{ ...source.files[0], target: "/secret" }] },
    { files: [{ path: "SPEC.md", content: "\0" }] },
    { files: [{ path: "SPEC.md", content: "é".repeat(17000) }] },
    { files: new Array(1) },
    { files: Array.from({ length: 33 }, (_, i) => ({ path: `tests/t${i}.ts`, content: "x" })) },
    {
      files: Array.from({ length: 3 }, (_, i) => ({
        path: `tests/t${i}.ts`,
        content: "x".repeat(32768)
      }))
    }
  ])
    assert.throws(() => validateSource(value));
  await assert.rejects(readSource(Readable.from(["x".repeat(131072), "x"])), /byte limit/);
});
