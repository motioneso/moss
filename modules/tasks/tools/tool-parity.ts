// Differential check of legacy executors and the real Tasks component on a gate DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import type { ToolExecute } from "@moss/module-sdk";
import * as legacy from "../../../packages/tasks/src/tools.js";

assert.equal(process.env["JARVIS_GATE_RUN"], "1", "Use verify-gate");
const urls = getMossDatabaseUrls();
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
const database = createDatabase({ connectionString: urls.app, maxConnections: 2 });
const runner = new DataContextRunner(database);
const actors = { ts: randomUUID(), rs: randomUUID() };
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
const exit = new Promise<number | null>((done, fail) => {
  child.once("exit", done);
  child.once("error", fail);
});
const lines = createInterface({ input: child.stdout });
const iterator = lines[Symbol.asyncIterator]();
const handlers: Record<string, ToolExecute> = {
  "tasks.create": legacy.taskCreateExecute,
  "tasks.update": legacy.taskUpdateExecute,
  "tasks.updateStatus": legacy.taskUpdateStatusExecute,
  "tasks.breakDown": legacy.taskBreakDownExecute,
  "tasks.addActivity": legacy.taskAddActivityExecute,
  "tasks.assignTag": legacy.taskAssignTagExecute,
  "tasks.unassignTag": legacy.taskUnassignTagExecute,
  "tasks.createList": legacy.taskCreateListExecute,
  "tasks.renameList": legacy.taskRenameListExecute,
  "tasks.createTag": legacy.taskCreateTagExecute,
  "tasks.renameTag": legacy.taskRenameTagExecute,
  "tasks.deleteTag": legacy.taskDeleteTagExecute
};
const ids: Record<string, Map<string, string>> = { ts: new Map(), rs: new Map() };
function canonical(value: unknown, side: string, key = ""): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => canonical(v, side));
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value!).map(([k, v]) => [k, canonical(v, side, k)]));
  if (
    typeof value === "string" &&
    [
      "id",
      "ownerUserId",
      "listId",
      "parentTaskId",
      "taskId",
      "actorUserId",
      "recurrenceSeriesId"
    ].includes(key)
  ) {
    const map = ids[side]!;
    if (!map.has(value)) map.set(value, `id-${map.size}`);
    return map.get(value);
  }
  if (["createdAt", "updatedAt", "completedAt"].includes(key)) return "<time>";
  return value;
}
const results: Record<string, Record<string, unknown>> = { ts: {}, rs: {} };
let count = 0;
async function compare(
  name: string,
  tool: string,
  input: (side: string) => Record<string, unknown>,
  rejects = false
) {
  const tsInput = input("ts");
  const rsInput = input("rs");
  let rejected = false;
  const expected = await runner
    .withDataContext({ actorUserId: actors.ts, requestId: "tool-differential" }, (db) =>
      handlers[tool]!(db, tsInput, {
        actorUserId: actors.ts,
        requestId: "tool-differential",
        chatSessionId: "test"
      })
    )
    .catch((error: unknown) => {
      if (!rejects) throw error;
      rejected = true;
      return undefined;
    });
  child.stdin.write(
    `${JSON.stringify({ actor: actors.rs, request: { tool, parameters: rsInput } })}\n`
  );
  const line = await iterator.next();
  assert(!line.done, "Component tool adapter stopped early");
  const actual = JSON.parse(line.value) as { ok?: unknown; error?: boolean };
  if (rejects) {
    assert(rejected, `${name}: TypeScript must reject`);
    assert.equal(actual.error, true, `${name}: component must reject`);
    count++;
    console.log(`PASS compiled tool differential: ${name} (both reject)`);
    return;
  }
  assert(expected);
  assert(!actual.error, `${name}: component failed`);
  assert.deepEqual(canonical(actual.ok, "rs"), canonical(expected, "ts"), name);
  results["ts"]![name] = expected.data as Record<string, unknown>;
  results["rs"]![name] = (actual.ok as { data: Record<string, unknown> }).data;
  count++;
  console.log(`PASS compiled tool differential: ${name}`);
}
function id(side: string, step: string, field: string) {
  return (results[side]![step]![field] as { id: string }).id;
}
try {
  await bootstrap.connect();
  for (const actor of Object.values(actors))
    await bootstrap.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'Tool parity')", [
      actor,
      `${actor}@example.test`
    ]);
  await compare("list", "tasks.createList", () => ({ name: "  Work  " }));
  await compare("list duplicate", "tasks.createList", () => ({ name: "  work  " }));
  await compare("list rename", "tasks.renameList", (s) => ({
    listId: id(s, "list", "list"),
    name: "Renamed"
  }));
  await compare("tag", "tasks.createTag", (s) => ({
    listId: id(s, "list", "list"),
    name: "  Tag  "
  }));
  await compare("tag rename", "tasks.renameTag", (s) => ({
    listId: id(s, "list", "list"),
    tagId: id(s, "tag", "tag"),
    name: "Renamed tag"
  }));
  await compare("create", "tasks.create", (s) => ({
    listId: id(s, "list", "list"),
    title: "  Task  ",
    description: "  Body  ",
    priority: 3
  }));
  await compare(
    "empty title rejected by database",
    "tasks.update",
    (s) => ({ taskId: id(s, "create", "task"), title: "" }),
    true
  );
  await compare("update", "tasks.update", (s) => ({
    taskId: id(s, "create", "task"),
    title: "  Updated  ",
    description: ""
  }));
  await compare("set dates and effort", "tasks.update", (s) => ({
    taskId: id(s, "create", "task"),
    dueAt: "2026-11-10T12:30:00.000Z",
    doAt: "2026-11-09T09:00:00.000Z",
    effort: "medium"
  }));
  await compare("parent", "tasks.create", (s) => ({
    title: "Parent",
    listId: id(s, "list", "list")
  }));
  await compare("set parent", "tasks.update", (s) => ({
    taskId: id(s, "create", "task"),
    parentTaskId: id(s, "parent", "task")
  }));
  await compare("clear nullable fields", "tasks.update", (s) => ({
    taskId: id(s, "create", "task"),
    description: null,
    priority: null,
    dueAt: null,
    doAt: null,
    effort: null,
    parentTaskId: null,
    recurrence: null
  }));
  await compare("suggested create", "tasks.create", (s) => ({
    title: "Suggested",
    status: "suggested",
    listId: id(s, "list", "list")
  }));
  await compare("note", "tasks.addActivity", (s) => ({
    taskId: id(s, "create", "task"),
    body: "  Note  "
  }));
  await compare("assign", "tasks.assignTag", (s) => ({
    taskId: id(s, "create", "task"),
    tagId: id(s, "tag", "tag")
  }));
  await compare("unassign", "tasks.unassignTag", (s) => ({
    taskId: id(s, "create", "task"),
    tagId: id(s, "tag", "tag")
  }));
  for (const status of ["done", "archived", "todo", "suggested"])
    await compare(`status ${status}`, "tasks.updateStatus", (s) => ({
      taskId: id(s, "create", "task"),
      status
    }));
  await compare("breakdown", "tasks.breakDown", (s) => ({
    taskId: id(s, "create", "task"),
    steps: ["  First  ", "Second"]
  }));
  await compare("empty breakdown", "tasks.breakDown", (s) => ({
    taskId: id(s, "create", "task"),
    steps: []
  }));
  await compare("other list", "tasks.createList", () => ({ name: "Other" }));
  await compare("assign before move", "tasks.assignTag", (s) => ({
    taskId: id(s, "create", "task"),
    tagId: id(s, "tag", "tag")
  }));
  await compare("assign child before move", "tasks.assignTag", (s) => ({
    taskId: (results[s]!["breakdown"]!["tasks"] as { id: string }[])[0]!.id,
    tagId: id(s, "tag", "tag")
  }));
  await compare("move parent with children", "tasks.update", (s) => ({
    taskId: id(s, "create", "task"),
    listId: id(s, "other list", "list")
  }));
  for (const side of ["ts", "rs"] as const) {
    const links = await bootstrap.query(
      "SELECT count(*)::int AS n FROM app.task_tag_assignments a JOIN app.tasks t ON t.id=a.task_id WHERE t.owner_user_id=$1",
      [actors[side]]
    );
    assert.equal(links.rows[0].n, 0, `${side}: list move drops parent and child tags`);
  }
  await compare("complete parent with children", "tasks.updateStatus", (s) => ({
    taskId: id(s, "create", "task"),
    status: "done"
  }));
  await compare("recurring", "tasks.create", (s) => ({
    title: "Recurring",
    listId: id(s, "list", "list"),
    dueAt: "2026-11-10T12:30:00.000Z",
    doAt: "2026-11-09T09:00:00.000Z",
    effort: "quick",
    recurrence: { freq: "daily", interval: 1, occurrence_date: "2026-11-10" }
  }));
  await compare("set recurrence", "tasks.update", (s) => ({
    taskId: id(s, "recurring", "task"),
    recurrence: { freq: "weekly", interval: 2, occurrence_date: "2026-11-10" }
  }));
  await compare("complete recurring", "tasks.updateStatus", (s) => ({
    taskId: id(s, "recurring", "task"),
    status: "done"
  }));
  const missing = randomUUID();
  for (const tool of ["tasks.update", "tasks.updateStatus", "tasks.addActivity"])
    await compare(`missing ${tool}`, tool, () => ({
      taskId: missing,
      title: "Missing",
      status: "done",
      body: "Missing"
    }));
  await compare(
    "missing parent",
    "tasks.create",
    (s) => ({ title: "Refused", listId: id(s, "list", "list"), parentTaskId: missing }),
    true
  );
  await compare(
    "foreign list",
    "tasks.create",
    (s) => ({ title: "Refused", listId: id(s === "ts" ? "rs" : "ts", "list", "list") }),
    true
  );
  await compare(
    "hidden parent",
    "tasks.create",
    (s) => ({
      title: "Refused",
      listId: id(s, "list", "list"),
      parentTaskId: id(s === "ts" ? "rs" : "ts", "parent", "task")
    }),
    true
  );
  await compare(
    "foreign tag",
    "tasks.assignTag",
    (s) => ({ taskId: id(s, "parent", "task"), tagId: id(s === "ts" ? "rs" : "ts", "tag", "tag") }),
    true
  );
  await compare("delete tag", "tasks.deleteTag", (s) => ({
    listId: id(s, "list", "list"),
    tagId: id(s, "tag", "tag")
  }));
  // Compare persisted rows too: cascades, dropped tags and generated occurrences
  // are not all returned by a mutation. Only IDs and wall-clock stamps normalize.
  const snapshots: Record<string, unknown> = {};
  for (const side of ["ts", "rs"] as const) {
    const rows = await bootstrap.query(
      `SELECT jsonb_build_object(
      'id',id,'ownerUserId',owner_user_id,'listId',list_id,'parentTaskId',parent_task_id,
      'title',title,'description',description,'status',status,'priority',priority,
      'dueAt',due_at,'doAt',do_at,'effort',effort,'source',source,'recurrence',recurrence,
      'recurrenceSeriesId',recurrence_series_id,'completedAt',completed_at) AS task
      FROM app.tasks WHERE owner_user_id=$1 ORDER BY title,source,due_at NULLS FIRST`,
      [actors[side]]
    );
    snapshots[side] = canonical(
      rows.rows.map((row: { task: unknown }) => row.task),
      side
    );
  }
  assert.deepEqual(snapshots.rs, snapshots.ts, "persisted task cascades and recurrence");
  console.log("PASS compiled tool differential: persisted task effects");
  console.log(
    `PASS ${count} compiled tool differential cases against current TypeScript executors`
  );
} finally {
  child.stdin.end();
  lines.close();
  if ((await exit) !== 0) process.exitCode = 1;
  await database.destroy();
  await bootstrap.end();
}
