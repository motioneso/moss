// An interactive fixture: browser writes go to a fresh gate database through the
// signed Tasks package. Never point this at a real installation.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  watch,
  writeFileSync
} from "node:fs";
import https from "node:https";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { getMossDatabaseUrls } from "@moss/db";

assert(process.env["JARVIS_GATE_RUN"] === "1", "Use scripts/run-gate.sh");
const out = process.env["TASKS_UI_OUT"]!;
mkdirSync(out, { recursive: true, mode: 0o700 });
const port = Number(
  execFileSync("devports", ["claim", `js59-tasks-ui-${process.pid}`], { encoding: "utf8" }).trim()
);
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<number | null> | undefined;
try {
  const base = `https://127.0.0.1:${port}`;
  // TASKS_UI_LAN_HOSTS (comma-separated addresses) lets a second device on the LAN or
  // tailnet reach the fixture over HTTPS. Without it the fixture stays on loopback.
  const lanHosts = (process.env["TASKS_UI_LAN_HOSTS"] ?? "").split(",").filter(Boolean);
  const origins = [
    base,
    `https://localhost:${port}`,
    ...lanHosts.map((host) => `https://${host}:${port}`)
  ];
  const urls = getMossDatabaseUrls();
  const binary = join(
    process.env["CARGO_TARGET_DIR"] ?? resolve("modules/tasks/tools/target"),
    "debug/tasks-ui-check"
  );
  const credentials = join(out, "credentials.json");
  writeFileSync(
    credentials,
    JSON.stringify({
      app_url: urls.app,
      auth_url: urls.auth,
      auth_secret: randomBytes(48).toString("hex"),
      connector_key: randomBytes(32).toString("hex")
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    join(out, "network.json"),
    JSON.stringify({
      listen: `${lanHosts.length ? "0.0.0.0" : "127.0.0.1"}:${port}`,
      origins,
      sharing: lanHosts.length > 0,
      certificate: join(out, "tls/certificate.pem"),
      private_key: join(out, "tls/key.pem"),
      credentials
    }),
    { mode: 0o600 }
  );
  execFileSync(binary, ["--certificate", join(out, "tls"), ...origins], { stdio: "inherit" });
  const log = openSync(join(out, "server.log"), "w", 0o600);
  child = spawn(binary, [], {
    stdio: ["ignore", log, log],
    env: { ...process.env, TASKS_UI_BOOTSTRAP_URL: urls.bootstrap, TASKS_UI_PRODUCER_URL: urls.app }
  });
  const running = new Promise<number | null>((done, fail) => {
    child!.once("exit", done);
    child!.once("error", fail);
  });
  exited = running;
  closeSync(log);
  const ca = readFileSync(join(out, "tls/certificate.pem"));
  function status(headers: Record<string, string>) {
    return new Promise<number>((done, fail) => {
      const request = https.get(
        `${base}/tasks`,
        { ca, servername: "localhost", headers },
        (response) => {
          response.resume();
          done(response.statusCode ?? 0);
        }
      );
      request.setTimeout(10000, () => request.destroy(new Error("HTTPS check deadline")));
      request.on("error", fail);
    });
  }
  // Bound startup only; completion uses a filesystem notification, not a busy poll.
  for (let attempt = 0; !existsSync(join(out, "listening")); attempt++) {
    assert(
      attempt < 120 && child.exitCode === null,
      "Tasks UI fixture did not start; inspect its bounded log"
    );
    await delay(500);
  }
  assert.equal(await status({}), 303, "Unsigned browser must reach sign-in");
  assert.equal(
    await status({ host: `untrusted.example:${port}` }),
    421,
    "Unknown authority refused"
  );
  assert.equal(
    await status({ origin: "https://untrusted.example" }),
    403,
    "Unknown origin refused"
  );
  console.log(
    "PASS native HTTPS with certificate verification; sign-in redirect; untrusted host and origin refused"
  );
  writeFileSync(join(out, "url.txt"), base);
  if (lanHosts.length) {
    writeFileSync(
      join(out, "lan-urls.txt"),
      lanHosts.map((host) => `https://${host}:${port}`).join("\n")
    );
    console.log(`Second-device addresses written to ${join(out, "lan-urls.txt")}`);
  }
  console.log(`Tasks package UI ready: ${base}/setup`);
  console.log(
    `After browser checks, create ${join(out, "finished")} containing checked to finish the gate.`
  );
  const receipt = await new Promise<string>((done, fail) => {
    const finish = () => {
      if (!existsSync(join(out, "finished"))) return;
      const receipt = readFileSync(join(out, "finished"), "utf8");
      // File creation can notify before the writer supplies its contents.
      if (!receipt.trim()) return;
      watcher.close();
      clearTimeout(timer);
      done(receipt);
    };
    const watcher = watch(out, finish);
    const timer = setTimeout(
      () => {
        watcher.close();
        fail(new Error("Browser check exceeded its fixture lifetime"));
      },
      45 * 60 * 1000
    );
    void running.then(() => {
      watcher.close();
      clearTimeout(timer);
      fail(new Error("UI server exited before browser verification"));
    });
    finish();
  });
  assert.equal(receipt.trim(), "checked", "Interactive check must explicitly finish");
  const db = new pg.Client({ connectionString: urls.bootstrap });
  await db.connect();
  try {
    const result = await db.query<{ count: string }>(
      "select count(*)::text as count from app.tasks where title = 'Browser proof task'"
    );
    assert.equal(result.rows[0]?.count, "1", "The real UI must create the proof task exactly once");
    if (process.env["TASKS_UI_FOCUS_PROOF"] === "1") {
      const rows = await db.query<{
        title: string;
        status: string;
        priority: number | null;
        dated: boolean;
      }>(
        "select title, status, priority, due_at is not null as dated from app.tasks where title in ('Browser proof task', 'Finished focus proof', 'Undated focus proof') order by title"
      );
      assert.deepEqual(rows.rows, [
        { title: "Browser proof task", status: "todo", priority: 5, dated: true },
        { title: "Finished focus proof", status: "done", priority: null, dated: false },
        { title: "Undated focus proof", status: "todo", priority: null, dated: false }
      ]);
      console.log(
        "PASS browser focus fixtures: high-priority dated open task, completed task and undated open task persisted with exact final states"
      );
    }
    if (process.env["TASKS_UI_REFRESH_PROOF"] === "1") {
      const parent = await db.query<{ status: string; description: string }>(
        "select status, description from app.tasks where title = 'Browser proof task'"
      );
      assert.deepEqual(parent.rows, [
        { status: "done", description: "Draft kept across completion" }
      ]);
      const children = await db.query<{ title: string; status: string }>(
        "select c.title, c.status from app.tasks c join app.tasks p on p.id=c.parent_task_id where p.title='Browser proof task'"
      );
      assert.deepEqual(children.rows, [{ title: "Last proof subtask", status: "done" }]);
      console.log(
        "PASS browser editor refresh: completed child and parent remain done after saving the preserved description draft"
      );
    }
    if (process.env["TASKS_UI_ACTIVITY_PROOF"] === "1") {
      const comments = await db.query<{ body: string }>(
        "select a.body from app.task_activity a join app.tasks t on t.id=a.task_id where t.title='Browser proof task' and a.activity_type='comment' order by a.created_at, a.id"
      );
      assert.deepEqual(
        comments.rows.map((entry) => entry.body),
        ["First proof line\nSecond proof line", "Button proof comment"]
      );
      console.log(
        "PASS browser activity: exact multiline keyboard comment and button comment persisted once each"
      );
    }
    if (process.env["TASKS_UI_QUICK_PROOF"] === "1") {
      const rows = await db.query<{ title: string; name: string }>(
        "select t.title, l.name from app.tasks t join app.task_lists l on l.id=t.list_id where t.title in ('Browser proof task', 'Quick chosen-list task') order by t.title"
      );
      assert.deepEqual(rows.rows, [
        { title: "Browser proof task", name: "Inbox" },
        { title: "Quick chosen-list task", name: "Second list" }
      ]);
      const handoff = await db.query<{ count: string }>(
        "select count(*)::text as count from app.tasks where title='Details handoff task'"
      );
      assert.equal(handoff.rows[0]?.count, "0", "Details must not save the draft");
      console.log(
        "PASS browser quick capture: exact task lists, one task each, unsaved Details handoff absent"
      );
    }
    if (process.env["TASKS_UI_SUGGESTION_PROOF"] === "1") {
      const assigned = await db.query<{ name: string }>(
        "select g.name from app.tasks t join app.task_tag_assignments a on a.task_id=t.id join app.task_tags g on g.id=a.tag_id where t.title='Browser proof task'"
      );
      assert.deepEqual(assigned.rows.map((tag) => tag.name).sort(), ["#literal", "WORK"]);
      const available = await db.query<{ name: string }>(
        "select g.name from app.task_tags g join app.task_lists l on l.id=g.list_id join app.tasks t on t.list_id=l.id where t.title='Browser proof task'"
      );
      assert.deepEqual(
        available.rows.map((tag) => tag.name).sort(),
        ["#literal", "WORK"],
        "suggested and typed tags reuse existing list tags"
      );
      console.log(
        "PASS browser tag suggestions: stored hash preserved; typed existing tag reused; no duplicate list tag created"
      );
    }
    if (process.env["TASKS_UI_DATE_PROOF"] === "1") {
      const dates = await db.query<{ due_at: Date; do_at: Date }>(
        "select due_at, do_at from app.tasks where title='Browser proof task'"
      );
      assert.equal(dates.rows[0]?.due_at.toISOString(), "2026-03-08T19:00:00.000Z");
      assert.equal(dates.rows[0]?.do_at.toISOString(), "2026-11-01T20:00:00.000Z");
      console.log(
        "PASS browser date proof: saved Pacific spring/fall dates persist at local noon, not UTC noon"
      );
    }
    if (process.env["TASKS_UI_CAPTURE_PROOF"] === "1") {
      const tags = await db.query<{ name: string }>(
        "select g.name from app.tasks t join app.task_tag_assignments a on a.task_id=t.id join app.task_tags g on g.id=a.tag_id where t.title='Browser proof task' order by g.name"
      );
      assert.deepEqual(tags.rows.map((tag) => tag.name).sort(), ["#literal", "kept", "typed"]);
      const steps = await db.query<{ title: string; position: number }>(
        "select s.title, s.position from app.tasks s join app.tasks p on p.id=s.parent_task_id where p.title='Browser proof task' order by s.position"
      );
      assert.deepEqual(steps.rows, [
        { title: "First proof step", position: 0 },
        { title: "Second proof step", position: 1 }
      ]);
      const removed = await db.query<{ count: string }>(
        "select count(*)::text as count from app.task_tags where name='discarded'"
      );
      assert.equal(removed.rows[0]?.count, "0");
      console.log(
        "PASS browser new-task capture: exact tags, ordered subtasks, discarded drafts absent and one parent persisted"
      );
    }
    if (process.env["TASKS_UI_LIST_DELETE_PROOF"] === "1") {
      const moved = await db.query<{ name: string; tags: string }>(
        "select l.name, (select count(*)::text from app.task_tag_assignments a where a.task_id=t.id) as tags from app.tasks t join app.task_lists l on l.id=t.list_id where t.title='Browser proof task'"
      );
      assert.deepEqual(moved.rows, [{ name: "Kept proof list", tags: "0" }]);
      const removed = await db.query<{ count: string }>(
        "select count(*)::text as count from app.task_lists where name='Removed proof list'"
      );
      assert.equal(removed.rows[0]?.count, "0");
      console.log(
        "PASS browser list deletion: task moved to the kept list; source list and old tag assignments are absent"
      );
    }
    if (process.env["TASKS_UI_TAG_PROOF"] === "1") {
      const tags = await db.query<{ name: string }>(
        "select g.name from app.tasks t join app.task_tag_assignments a on a.task_id=t.id join app.task_tags g on g.id=a.tag_id where t.title='Browser proof task' order by g.name"
      );
      assert.deepEqual(
        tags.rows.map((tag) => tag.name),
        ["Kept proof tag"]
      );
      const removed = await db.query<{ count: string }>(
        "select count(*)::text as count from app.task_tags where name='Removed proof tag'"
      );
      assert.equal(removed.rows[0]?.count, "0");
      console.log(
        "PASS browser tag proof: expected assigned tag is present; removed-name tag is absent; task is kept"
      );
    }
  } finally {
    await db.end();
  }
  console.log("PASS browser-created task persisted in the real Tasks table exactly once");
} finally {
  if (child && child.exitCode === null) child.kill("SIGINT");
  if (exited) await exited.catch(() => {});
  execFileSync("devports", ["release", String(port)], { stdio: "ignore" });
}
