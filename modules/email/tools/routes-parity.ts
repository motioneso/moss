/** Runs the old Email routes (real Fastify schemas and handlers, in-memory store) and
 *  the Rust guest on the same requests, and fails on any difference. No database. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { registerEmailRoutes } from "../../../packages/email/src/routes.js";

const binary = process.env.EMAIL_ORACLE;
assert(binary, "Build the email oracle first");
type Deps = Parameters<typeof registerEmailRoutes>[1];
type Case = {
  method: string;
  url: string;
  body?: unknown;
  seed?: { id: string; subject: string };
};
const cases: Case[] = JSON.parse(
  readFileSync(new URL("./routes-cases.json", import.meta.url), "utf8")
);

const TIME = new Date("2026-01-01T00:00:00.000Z");
const messages: Record<string, unknown>[] = [];
const stored = new Map<string, unknown>();
const repository = {
  listVisible: async () => messages,
  getById: async (_db: unknown, id: string) => messages.find((m) => m.id === id)
};
const preferences = {
  get: async (_db: unknown, key: string) => stored.get(key),
  upsert: async (_db: unknown, key: string, value: unknown) => {
    stored.set(key, value);
  }
};

const server = Fastify();
setMossErrorHandler(server);
registerEmailRoutes(server, {
  resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "parity" }),
  dataContext: {
    withDataContext: async (_ctx: unknown, work: (db: object) => unknown) => work({})
  } as unknown as Deps["dataContext"],
  repository: repository as unknown as never,
  preferencesRepository: preferences as unknown as never
});

try {
  const expected = [];
  for (const test of cases) {
    if (test.seed) {
      messages.push({
        id: test.seed.id,
        owner_user_id: "user-1",
        sender: "sender@example.test",
        recipients: ["me@example.test"],
        subject: test.seed.subject,
        snippet: null,
        body_excerpt: null,
        summary: null,
        signals: {},
        received_at: TIME,
        external_id: `ext-${test.seed.id}`,
        created_at: TIME,
        updated_at: TIME
      });
      continue;
    }
    const response = await server.inject({
      method: test.method as "GET",
      url: test.url,
      ...(test.body === undefined
        ? {}
        : { payload: JSON.stringify(test.body), headers: { "content-type": "application/json" } })
    });
    let body: unknown = null;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    expected.push({ status: response.statusCode, body });
  }
  const result = spawnSync(binary, { input: JSON.stringify(cases), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const actual: unknown[] = JSON.parse(result.stdout);
  assert.equal(actual.length, expected.length);
  const live = cases.filter((c) => !c.seed);
  for (const [index, value] of actual.entries())
    assert.deepEqual(
      value,
      expected[index],
      `${live[index].method} ${live[index].url} ${JSON.stringify(live[index].body)}`
    );
  console.log(`PASS ${actual.length} route comparisons against the old Email routes`);
} finally {
  await server.close();
}
