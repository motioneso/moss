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
    ["id", "ownerUserId", "listId", "parentTaskId", "taskId", "actorUserId"].includes(key)
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
  input: (side: string) => Record<string, unknown>
) {
  const tsInput = input("ts");
  const rsInput = input("rs");
  const expected = await runner.withDataContext(
    { actorUserId: actors.ts, requestId: "tool-differential" },
    (db) =>
      handlers[tool]!(db, tsInput, {
        actorUserId: actors.ts,
        requestId: "tool-differential",
        chatSessionId: "test"
      })
  );
  child.stdin.write(
    `${JSON.stringify({ actor: actors.rs, request: { tool, parameters: rsInput } })}\n`
  );
  const line = await iterator.next();
  assert(!line.done, "Component tool adapter stopped early");
  const actual = JSON.parse(line.value) as { ok?: unknown; error?: boolean };
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
  await compare("update", "tasks.update", (s) => ({
    taskId: id(s, "create", "task"),
    title: "",
    description: ""
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
  await compare("delete tag", "tasks.deleteTag", (s) => ({
    listId: id(s, "list", "list"),
    tagId: id(s, "tag", "tag")
  }));
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
