// Compare compiled focus/at-risk/overdue/summary reads with today's executors.
// Compare UTC plus account-local zones through the public host date contract.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import {
  taskAtRiskExecute,
  taskFocusExecute,
  taskOverdueExecute
} from "../../../packages/tasks/src/tools.js";
import { taskSummaryExecute } from "../../../packages/tasks/src/summary/tool.js";

assert.equal(process.env["JARVIS_GATE_RUN"], "1", "Use verify-gate");
const urls = getMossDatabaseUrls();
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
const database = createDatabase({ connectionString: urls.app, maxConnections: 2 });
const runner = new DataContextRunner(database);
const owner = randomUUID();
const other = randomUUID();
const admin = randomUUID();
const list = randomUUID();
const child = spawn(
  join(
    process.env["CARGO_TARGET_DIR"] ?? resolve("modules/tasks/tools/target"),
    "debug/tasks-tool-parity"
  ),
  [],
  { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, JS51_APP_URL: urls.app } }
);
const lines = createInterface({ input: child.stdout });
const iterator = lines[Symbol.asyncIterator]();
async function compiled(actor: string, tool: string, input: Record<string, unknown>) {
  child.stdin.write(`${JSON.stringify({ actor, request: { tool, parameters: input } })}\n`);
  const line = await iterator.next();
  assert(!line.done, "Component adapter ended early");
  const output = JSON.parse(line.value);
  assert(output.ok, `Compiled ${tool} must succeed: ${line.value}`);
  return output.ok;
}
const ctx = (actor: string) => ({
  actorUserId: actor,
  requestId: "drift-parity",
  chatSessionId: "test"
});
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "retrievedAt" ? "<time>" : scrub(v)])
    );
  return value;
}
try {
  await bootstrap.connect();
  for (const actor of [owner, other, admin]) {
    await bootstrap.query(
      "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Drift parity',$3)",
      [actor, `${actor}@example.test`, actor === admin]
    );
    await bootstrap.query(
      `INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES($1,'locale','{"timezone":"UTC"}'::jsonb,now())`,
      [actor]
    );
  }
  await bootstrap.query("INSERT INTO app.task_lists(id,owner_user_id,name) VALUES($1,$2,'Main')", [
    list,
    owner
  ]);
  const day = 86400000;
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows: [string, string, number | null, string | null, string | null][] = [
    // title, status, priority, due, do
    ["overdue high", "todo", 5, iso(now - 10 * day), null],
    ["overdue low", "todo", 1, iso(now - 5 * day), null],
    ["risk soon", "todo", 3, iso(now + day), null],
    ["soon low priority", "todo", 2, iso(now + day), null],
    ["risk do past", "todo", 4, null, iso(now - day)],
    ["risk with done child", "todo", 5, iso(now + day), null],
    ["done overdue", "done", 5, iso(now - 10 * day), null],
    ["future high", "todo", 5, iso(now + 10 * day), null]
  ];
  const ids: string[] = [];
  for (const [title, status, priority, due, doAt] of rows) {
    const id = randomUUID();
    ids.push(id);
    await bootstrap.query(
      "INSERT INTO app.tasks(id,owner_user_id,list_id,title,status,priority,due_at,do_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, owner, list, title, status, priority, due, doAt]
    );
  }
  await bootstrap.query(
    "INSERT INTO app.tasks(id,owner_user_id,list_id,title,status,parent_task_id) VALUES($1,$2,$3,'done child','done',$4)",
    [randomUUID(), owner, list, ids[5]]
  );
  // Boundaries in UTC: due later today is not overdue; the end of today+2 is
  // at risk while the start of today+3 is not.
  const startToday = new Date();
  startToday.setUTCHours(0, 0, 0, 0);
  for (const [title, due] of [
    ["due later today", startToday.getTime() + 3600000],
    ["risk end of plus two", startToday.getTime() + 2 * day + 23 * 3600000],
    ["not risk plus three", startToday.getTime() + 3 * day]
  ] as const)
    await bootstrap.query(
      "INSERT INTO app.tasks(id,owner_user_id,list_id,title,status,priority,due_at) VALUES($1,$2,$3,$4,'todo',4,$5)",
      [randomUUID(), owner, list, title, iso(due)]
    );
  // Fourteen long titles push the summary text form over its legacy bound,
  // so both sides must drop rows from the end and mark the result partial.
  for (let i = 0; i < 14; i++)
    await bootstrap.query(
      "INSERT INTO app.tasks(id,owner_user_id,list_id,title,status,priority,due_at) VALUES($1,$2,$3,$4,'todo',3,$5)",
      [randomUUID(), owner, list, `Long ${i} ${"x".repeat(340)}`, iso(now - (20 + i) * day)]
    );
  const tools: Record<string, (db: never, input: never, c: never) => Promise<unknown>> = {
    "tasks.focus": taskFocusExecute as never,
    "tasks.atRisk": taskAtRiskExecute as never,
    "tasks.overdue": taskOverdueExecute as never
  };
  let checks = 0;
  async function compare(actors: string[]) {
    for (const actor of actors)
      for (const [tool, execute] of Object.entries(tools)) {
        const expected = await runner.withDataContext(
          { actorUserId: actor, requestId: "drift-parity" },
          (db) => execute(db as never, {} as never, ctx(actor) as never)
        );
        assert.deepEqual(
          scrub(await compiled(actor, tool, {})),
          scrub(expected),
          `${tool} ${actor}`
        );
        checks++;
      }
    for (const actor of actors)
      for (const scope of [
        "today",
        "overdue",
        "upcoming",
        "undated",
        "completed",
        "all",
        undefined
      ]) {
        const input = scope === undefined ? {} : { scope };
        const expected = await runner.withDataContext(
          { actorUserId: actor, requestId: "drift-parity" },
          (db) => taskSummaryExecute(db, input, ctx(actor))
        );
        assert.deepEqual(
          scrub(await compiled(actor, "tasks.summary", input)),
          scrub(expected),
          `summary ${scope} ${actor}`
        );
        checks++;
      }
  }
  await compare([owner, other, admin]);
  // Include both sides of the UTC date line and fractional offsets. Boundary
  // rows remain identical; only each actor's persisted locale changes.
  for (const timezone of [
    "America/Los_Angeles",
    "asia/tokyo",
    "Pacific/Kiritimati",
    "Asia/Kathmandu"
  ]) {
    await bootstrap.query(
      "UPDATE app.preferences SET value_json=$2 WHERE owner_user_id=$1 AND key='locale'",
      [owner, { timezone }]
    );
    await compare([owner]);
  }
  // Privacy: removing RLS must expose the owner's rows and fail the hidden check.
  const hidden = (out: { data: { items: unknown[] } }) =>
    assert.deepEqual(out.data.items, [], "Private drift rows must be hidden");
  hidden(await compiled(other, "tasks.overdue", {}));
  await bootstrap.query("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
  try {
    const exposedAll = await compiled(other, "tasks.overdue", {});
    // Scope the probe to this script's synthetic list: earlier gate fixtures
    // also become visible when RLS is off and are not part of this assertion.
    const exposed = {
      data: {
        items: exposedAll.data.items.filter((item: { listId: string }) => item.listId === list)
      }
    };
    assert.equal(exposed.data.items.length, 16);
    assert.throws(() => hidden(exposed), assert.AssertionError);
    console.log("PASS compiled drift privacy assertion fails with RLS removed");
  } finally {
    await bootstrap.query(
      "ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY"
    );
  }
  hidden(await compiled(other, "tasks.overdue", {}));
  console.log(`PASS ${checks} exact compiled drift/summary comparisons; private and admin hidden`);
} finally {
  child.stdin.end();
  await database.destroy?.();
  await bootstrap.end().catch(() => undefined);
}
