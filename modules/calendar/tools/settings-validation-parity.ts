/** Compare request normalization and errors with the production Fastify schema. No DB. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import Fastify from "fastify";
import { updateCalendarBriefingSettingsRouteSchema } from "@moss/shared";

const binary = process.env.CALENDAR_DATA_ORACLE;
assert(binary, "Build Calendar data oracle first");
const cases: unknown[] = JSON.parse(
  readFileSync(new URL("./settings-patch-cases.json", import.meta.url), "utf8")
);
const server = Fastify();
server.patch(
  "/settings",
  {
    schema: {
      body: updateCalendarBriefingSettingsRouteSchema.body,
      response: { 400: updateCalendarBriefingSettingsRouteSchema.response[400] }
    }
  },
  async (request) => request.body
);
try {
  const expected = [];
  for (const body of cases) {
    const response = await server.inject({
      method: "PATCH",
      url: "/settings",
      payload: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    });
    expected.push({ ok: { status: response.statusCode, body: response.json() as unknown } });
  }
  const result: SpawnSyncReturns<string> = spawnSync(binary, {
    input: JSON.stringify(cases.map((value) => ({ op: "settings-http", value }))),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const actual: unknown[] = JSON.parse(result.stdout);
  assert.equal(actual.length, expected.length);
  for (const [index, value] of actual.entries()) {
    assert.deepEqual(value, expected[index], JSON.stringify(cases[index]));
  }
  console.log(
    `PASS ${cases.length} settings request normalization/error comparisons against production Fastify schema`
  );
} finally {
  await server.close();
}
