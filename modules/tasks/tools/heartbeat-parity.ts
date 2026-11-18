// Exact comparison with the current executor; both read the same synthetic rows.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { tasksHeartbeatWindowExecute } from "../../../packages/tasks/src/heartbeat.js";

assert.equal(process.env["JARVIS_GATE_RUN"], "1", "Use verify-gate");
const urls = getMossDatabaseUrls();
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
const database = createDatabase({ connectionString: urls.app, maxConnections: 2 });
const runner = new DataContextRunner(database);
const actor = randomUUID();
const other = randomUUID();
const child = spawn(
  join(
    process.env["CARGO_TARGET_DIR"] ?? resolve("modules/tasks/tools/target"),
    "debug/tasks-tool-parity"
  ),
  [],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, JS51_APP_URL: urls.app }
  }
);
const exited = new Promise<number | null>((done, fail) => {
  child.once("exit", done);
  child.once("error", fail);
});
const lines = createInterface({ input: child.stdout });
const iterator = lines[Symbol.asyncIterator]();
try {
  await bootstrap.connect();
  for (const id of [actor, other])
    await bootstrap.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'Heartbeat parity')", [
      id,
      `${id}@example.test`
    ]);
  const list = randomUUID();
  await bootstrap.query(
    "INSERT INTO app.task_lists(id,owner_user_id,name) VALUES($1,$2,'Heartbeat')",
    [list, actor]
  );
  const shared = randomUUID();
  const now = Date.now();
  // Stable boundaries, Unicode, null priority, closed/undated rows and a lookahead row.
  for (let i = 0; i < 26; i++)
    await bootstrap.query(
      "INSERT INTO app.tasks(id,owner_user_id,list_id,title,priority,status,due_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        i === 0 ? shared : randomUUID(),
        actor,
        list,
        `🪴 café ${i}`,
        i % 2 ? null : 4,
        i === 24 ? "done" : "todo",
        i === 25 ? null : new Date(now + (i - 1) * 3_600_000)
      ]
    );
  await bootstrap.query(
    "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('task',$1,$2,$3,'view')",
    [shared, actor, other]
  );
  const snapshot = async () =>
    (
      await bootstrap.query(
        "SELECT jsonb_agg(to_jsonb(t) ORDER BY id) AS rows FROM app.tasks t WHERE owner_user_id=$1",
        [actor]
      )
    ).rows[0].rows;
  const before = await snapshot();
  for (const who of [actor, other])
    for (const input of [
      {},
      { limit: 1 },
      { limit: 3, horizonHours: 1 },
      { limit: 20, horizonHours: 48 }
    ]) {
      const expected = await runner.withDataContext(
        { actorUserId: who, requestId: "heartbeat-parity" },
        (db) =>
          tasksHeartbeatWindowExecute(db, input, {
            actorUserId: who,
            requestId: "heartbeat-parity",
            chatSessionId: "test"
          })
      );
      child.stdin.write(
        `${JSON.stringify({ actor: who, request: { tool: "tasks.heartbeatWindow", parameters: input } })}\n`
      );
      const line = await iterator.next();
      assert(!line.done, "Component adapter ended early");
      const actual = JSON.parse(line.value);
      assert.deepEqual(actual.ok, expected);
      console.log(
        `PASS exact compiled heartbeat differential: ${who === actor ? "owner" : "view-shared reader"} ${JSON.stringify(input)}`
      );
    }
  assert.deepEqual(
    await snapshot(),
    before,
    "Heartbeat reads must leave every stored task field unchanged"
  );
  console.log("PASS compiled heartbeat leaves persisted rows unchanged");
} finally {
  child.stdin.end();
  await exited;
  lines.close();
  await database.destroy();
  await bootstrap.end();
}
