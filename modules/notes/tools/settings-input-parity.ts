// Actual legacy Fastify schemas; folder admission/persistence is an explicit
// echo stand-in here. settings-oracle.ts checks real handlers and saved rows.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import {
  getNotesSourceDirectoriesRouteSchema,
  putNotesSourceRouteSchema
} from "../../../packages/shared/src/notes-api.js";

const server = Fastify();
server.put("/notes-source", { schema: putNotesSourceRouteSchema }, async (request) => ({
  path: (request.body as { path?: unknown } | null)?.path ?? null
}));
server.get(
  "/notes-source/directories",
  { schema: { querystring: getNotesSourceDirectoriesRouteSchema.querystring } },
  async (request) => ({ path: (request.query as { path?: string }).path ?? null })
);
setMossErrorHandler(server);
const values = [
  null,
  false,
  true,
  0,
  42,
  -42,
  0.000001,
  1e-7,
  1e20,
  1e21,
  Number("9007199254740993"),
  1.25,
  "",
  "/notes",
  {},
  [],
  [null],
  [false],
  [0],
  [""],
  ["/notes"],
  ["a", "b"],
  [[null]]
];
const vectors = [];
try {
  for (const body of [
    ...values,
    ...values.map((path) => ({ path })),
    { path: "/notes", actorUserId: "other", ignored: true },
    { actorUserId: "other" }
  ]) {
    const reply = await server.inject({
      method: "PUT",
      url: "/notes-source",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body)
    });
    vectors.push({
      request: { method: "PUT", path: "/notes-source", body },
      expected: { status: reply.statusCode, body: reply.json() }
    });
  }
  for (const query of [
    "",
    "ignored=value",
    "path=",
    "path=%2Fnotes",
    "path=false",
    "path=%2Fnotes&actorUserId=other",
    "path=a&path=b",
    "path=&path=",
    "ignored=a&ignored=b"
  ]) {
    const params: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(query)) {
      const previous = params[key];
      params[key] =
        previous === undefined
          ? value
          : [...(Array.isArray(previous) ? previous : [previous]), value];
    }
    const reply = await server.inject(`/notes-source/directories?${query}`);
    vectors.push({
      request: { method: "GET", path: "/notes-source/directories", query: params },
      expected: { status: reply.statusCode, body: reply.json() }
    });
  }
  const reply = await server.inject({ method: "PUT", url: "/notes-source" });
  vectors.push({
    request: { method: "PUT", path: "/notes-source" },
    expected: { status: reply.statusCode, body: reply.json() }
  });
} finally {
  await server.close();
}
const path = new URL("../src/tests/settings-input-vectors.jsonl", import.meta.url);
const corpus = vectors.map((v) => JSON.stringify(v)).join("\n") + "\n";
if (process.argv.includes("--check")) assert.equal(readFileSync(path, "utf8"), corpus);
else writeFileSync(path, corpus);
console.log(`PASS ${vectors.length} legacy Settings schema cases (folder admission echo stand-in)`);
