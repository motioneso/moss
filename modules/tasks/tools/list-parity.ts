// Compare compiled list reads with today's executor on the same synthetic rows.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { taskListExecute } from "../../../packages/tasks/src/tools.js";

assert.equal(process.env["JARVIS_GATE_RUN"], "1", "Use verify-gate");
const urls = getMossDatabaseUrls();
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
const database = createDatabase({ connectionString: urls.app, maxConnections: 2 });
const runner = new DataContextRunner(database);
const owner = randomUUID();
const other = randomUUID();
const admin = randomUUID();
const list = randomUUID();
const secondList = randomUUID();
const tag = randomUUID();
const child = spawn(
  join(
    process.env["CARGO_TARGET_DIR"] ?? resolve("modules/tasks/tools/target"),
    "debug/tasks-tool-parity"
  ),
  [],
  { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, JS51_APP_URL: urls.app } }
);
const exited = new Promise<number | null>((done, fail) => {
  child.once("exit", done);
  child.once("error", fail);
});
const lines = createInterface({ input: child.stdout });
const iterator = lines[Symbol.asyncIterator]();
async function compiled(actor: string, input: Record<string, unknown>) {
  child.stdin.write(
    `${JSON.stringify({ actor, request: { tool: "tasks.list", parameters: input } })}\n`
  );
  const line = await iterator.next();
  assert(!line.done, "Component adapter ended early");
  const output = JSON.parse(line.value);
  assert(output.ok, `Compiled list must succeed for ${JSON.stringify(input)}: ${line.value}`);
  return output.ok;
}
try {
  await bootstrap.connect();
  for (const actor of [owner, other, admin])
    await bootstrap.query(
      "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'List parity',$3)",
      [actor, `${actor}@example.test`, actor === admin]
    );
  for (const id of [list, secondList])
    await bootstrap.query("INSERT INTO app.task_lists(id,owner_user_id,name) VALUES($1,$2,$3)", [
      id,
      owner,
      id
    ]);
  await bootstrap.query(
    "INSERT INTO app.task_tags(id,owner_user_id,list_id,name) VALUES($1,$2,$3,'Filter tag')",
    [tag, owner, list]
  );
  const shared = randomUUID();
  const boundary = "2026-01-02T12:00:00.000Z";
  for (let i = 0; i < 12; i++) {
    const id = i === 1 ? shared : randomUUID();
    await bootstrap.query(
      "INSERT INTO app.tasks(id,owner_user_id,list_id,title,status,priority,due_at,completed_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        owner,
        i < 6 ? list : secondList,
        `List row ${i}`,
        ["todo", "done", "archived", "suggested"][i % 4],
        i % 6 || null,
        i % 3 === 0 ? null : i % 3 === 1 ? boundary : "2099-01-01T00:00:00Z",
        i % 4 === 1 ? boundary : null,
        boundary
      ]
    );
    if (i === 1 || i === 2)
      await bootstrap.query("INSERT INTO app.task_tag_assignments(task_id,tag_id) VALUES($1,$2)", [
        id,
        tag
      ]);
  }
  const snapshot = async () =>
    (
      await bootstrap.query(
        "SELECT jsonb_agg(to_jsonb(t) ORDER BY id) AS rows FROM app.tasks t WHERE owner_user_id=$1",
        [owner]
      )
    ).rows[0].rows;
  const before = await snapshot();
  const inputs: Record<string, unknown>[] = [
    {},
    { listId: list },
    { listId: secondList },
    { tagId: tag },
    ...["todo", "done", "archived"].map((status) => ({ status })),
    ...[1, 2, 3, 4, 5].map((priority) => ({ priority })),
    { dueBefore: boundary },
    { dueAfter: boundary },
    { dueAfter: "2026-01-02" },
    { dueBefore: "2026-01-02T12:00:00+02:00" },
    { completedAfter: boundary },
    { completedAfter: "2026-01-02T11:59:59.999Z" },
    { dueAfter: "2026-01-02T11:59:59.999Z", dueBefore: "2026-01-02T12:00:00.001Z" },
    ...["do", "schedule", "delegate", "eliminate"].map((quadrant) => ({ quadrant })),
    { listId: list, tagId: tag, status: "archived", priority: 2, quadrant: "eliminate" },
    { dueBefore: "", dueAfter: "", completedAfter: "" },
    { tagId: randomUUID() },
    { listId: randomUUID() }
  ];
  let checks = 0;
  for (const actor of [owner, other, admin])
    for (const input of inputs) {
      const expected = await runner.withDataContext(
        { actorUserId: actor, requestId: "list-parity" },
        (db) =>
          taskListExecute(db, input, {
            actorUserId: actor,
            requestId: "list-parity",
            chatSessionId: "test"
          })
      );
      assert.deepEqual(await compiled(actor, input), expected);
      checks++;
    }
  // RLS removal must expose the actual private rows and fail this exact assertion.
  const assertPrivate = (output: { data: { items: unknown[] } }) =>
    assert.deepEqual(output.data.items, [], "Private list rows must be hidden");
  assertPrivate(await compiled(other, {}));
  await bootstrap.query("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
  try {
    const exposed = await compiled(other, {});
    assert.equal(
      exposed.data.items.filter((item: { ownerUserId: string }) => item.ownerUserId === owner)
        .length,
      12
    );
    assert(exposed.data.items.some((item: { id: string }) => item.id === shared));
    assert.throws(() => assertPrivate(exposed), assert.AssertionError);
    console.log("PASS compiled list privacy assertion fails with RLS removed");
  } finally {
    await bootstrap.query(
      "ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY"
    );
  }
  assertPrivate(await compiled(other, {}));
  await bootstrap.query(
    "INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('task',$1,$2,$3,'view')",
    [shared, owner, other]
  );
  const visible = await compiled(other, {});
  assert.deepEqual(
    visible.data.items.map((item: { id: string }) => item.id),
    [shared]
  );
  assert.deepEqual(await compiled(other, { listId: list }), visible);
  assertPrivate(await compiled(other, { tagId: tag }));
  for (const input of [{}, { listId: list }, { tagId: tag }]) {
    const expected = await runner.withDataContext(
      { actorUserId: other, requestId: "shared-list-parity" },
      (db) =>
        taskListExecute(db, input, {
          actorUserId: other,
          requestId: "shared-list-parity",
          chatSessionId: "test"
        })
    );
    assert.deepEqual(await compiled(other, input), expected);
    checks++;
  }
  assertPrivate(await compiled(admin, {}));
  assert.deepEqual(
    await snapshot(),
    before,
    "These non-recurring list reads must not write any task field"
  );
  console.log(
    `PASS ${checks} exact compiled list comparisons; private/admin/shared visibility; strict date boundaries; stable ordering; no writes on non-recurring data`
  );
  // Optional acceptance probe. Keep failure red under the default host limits;
  // this is deliberately separate from the small-account differential checks.
  if (process.env["TASKS_LIST_LARGE_ACCOUNT"] === "1") {
    await bootstrap.query(
      "INSERT INTO app.tasks(id,owner_user_id,list_id,title,updated_at) SELECT gen_random_uuid(),$1,$2,'Paged row ' || i,$3 FROM generate_series(1,1005) i",
      [owner, secondList, boundary]
    );
    const expectedPage = await runner.withDataContext(
      { actorUserId: owner, requestId: "list-paging" },
      (db) =>
        taskListExecute(
          db,
          { listId: secondList },
          { actorUserId: owner, requestId: "list-paging", chatSessionId: "test" }
        )
    );
    const actualPage = await compiled(owner, { listId: secondList });
    assert.equal(actualPage.data.items.length, 1011);
    assert.deepEqual(actualPage, expectedPage);
    console.log("PASS compiled list crosses task-page and assignment-chunk boundaries");
  }
} finally {
  child.stdin.end();
  await exited;
  lines.close();
  await database.destroy();
  await bootstrap.end();
}
