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
  const origins = [base, `https://localhost:${port}`];
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
      listen: `127.0.0.1:${port}`,
      origins,
      sharing: false,
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
    env: { ...process.env, TASKS_UI_BOOTSTRAP_URL: urls.bootstrap }
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
      const request = https.get(`${base}/tasks`, { ca, headers }, (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      });
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
  console.log(`Tasks package UI ready: ${base}/setup`);
  console.log(
    `After browser checks, create ${join(out, "finished")} containing checked to finish the gate.`
  );
  const receipt = await new Promise<string>((done, fail) => {
    const finish = () => {
      if (!existsSync(join(out, "finished"))) return;
      watcher.close();
      clearTimeout(timer);
      done(readFileSync(join(out, "finished"), "utf8"));
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
  } finally {
    await db.end();
  }
  console.log("PASS browser-created task persisted in the real Tasks table exactly once");
} finally {
  if (child && child.exitCode === null) child.kill("SIGINT");
  if (exited) await exited.catch(() => {});
  execFileSync("devports", ["release", String(port)], { stdio: "ignore" });
}
