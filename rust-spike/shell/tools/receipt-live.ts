// Run only through receipt-gate.sh and verify-gate: all data is disposable.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { getMossDatabaseUrls } from "../../../packages/db/src/urls.js";

assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
const urls = getMossDatabaseUrls();
const scratch = mkdtempSync(join(tmpdir(), "moss-desktop-receipts-"));
const target = process.env.CARGO_TARGET_DIR!;
assert(target, "Use a task-owned Cargo target");
const port = execFileSync("devports", ["claim", `js164-receipts-${process.pid}`], {
  encoding: "utf8"
}).trim();
const origin = `https://localhost:${port}`;
const certificate = join(scratch, "tls/certificate.pem");
const config = join(scratch, "network.json");
const credentials = join(scratch, "credentials.json");
const web = join(scratch, "web");
const admin = new pg.Client({ connectionString: urls.bootstrap });
const app = new pg.Client({ connectionString: urls.app });
let server: ChildProcess | undefined;
let ca: Buffer;
async function stop() {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
  }
}
async function request(path: string, cookie?: string, body?: unknown, wrongOrigin = false) {
  return new Promise<{ status: number; data: Record<string, unknown>; cookie: string }>(
    (resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        origin + path,
        {
          ca,
          rejectUnauthorized: true,
          agent: false,
          method: bytes ? "POST" : "GET",
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(bytes
              ? {
                  origin: wrongOrigin ? "https://wrong.example" : origin,
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(bytes)
                }
              : {})
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode!,
              data: raw.startsWith("{") ? JSON.parse(raw) : {},
              cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""
            });
          });
        }
      );
      req.setTimeout(10000, () => req.destroy(new Error("HTTPS deadline")));
      req.on("error", reject);
      req.end(bytes);
    }
  );
}
async function start() {
  const fd = openSync(join(scratch, "server.log"), "a", 0o600);
  server = spawn(join(target, "debug/moss-shell"), ["serve", "--network", config, "--web", web], {
    stdio: ["ignore", fd, fd],
    env: { PATH: process.env.PATH }
  });
  closeSync(fd);
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, "Server exited at startup");
    try {
      if ((await request("/api/hello")).status === 200) return;
    } catch {
      /* startup only */
    }
    await delay(100);
  }
  throw new Error("Server startup deadline");
}
async function scope(user: string) {
  await app.query("BEGIN");
  await app.query(
    "SELECT set_config('app.actor_user_id',$1,true),set_config('app.request_id','receipt-proof',true)",
    [user]
  );
}
try {
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Receipt HTTP fixture</title>");
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
    config,
    JSON.stringify({
      listen: `127.0.0.1:${port}`,
      origins: [origin],
      sharing: false,
      certificate,
      private_key: join(scratch, "tls/key.pem"),
      credentials
    }),
    { mode: 0o600 }
  );
  execFileSync(
    join(target, "debug/moss-network"),
    ["local-certificate", join(scratch, "tls"), origin],
    { stdio: "ignore" }
  );
  ca = readFileSync(certificate);
  await admin.connect();
  await app.connect();
  await start();
  assert.equal((await request("/api/desktop/notices")).status, 401);
  assert.equal(
    (
      await request("/api/desktop/notices", undefined, {
        client: randomUUID(),
        events: [randomUUID()]
      })
    ).status,
    401
  );
  const signup = await request("/api/auth/sign-up/email", undefined, {
    name: "Receipt proof owner",
    email: `receipt-${randomUUID()}@example.test`,
    password: randomBytes(32).toString("hex")
  });
  assert.equal(signup.status, 200, "Real owner setup");
  const cookie = signup.cookie;
  assert(cookie);
  const owner = (await admin.query("SELECT id FROM app.users WHERE is_instance_admin=true")).rows[0]
    .id as string;
  const member = randomUUID();
  await admin.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'Receipt proof member')", [
    member,
    `member-${member}@example.test`
  ]);
  const own = randomUUID(),
    foreign = randomUUID(),
    client = randomUUID(),
    otherClient = randomUUID();
  await admin.query(
    "INSERT INTO app.notifications(id,recipient_user_id,title) VALUES($1,$2,'Private owner notice'),($3,$4,'Private member notice')",
    [own, owner, foreign, member]
  );
  const path = `/api/desktop/notices?client=${client}`;
  const before = await request(path, cookie);
  assert.deepEqual(before.data.events, [own]);
  assert.deepEqual(before.data.acknowledged, []);
  assert(!JSON.stringify(before.data).includes("Private"));
  const acceptance = { client, events: [own, foreign, randomUUID(), own] };
  assert.equal((await request("/api/desktop/notices", cookie, acceptance, true)).status, 403);
  const accepted = await request("/api/desktop/notices", cookie, acceptance);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.data.acknowledged, [own]);
  assert.deepEqual((await request("/api/desktop/notices", cookie, acceptance)).data.acknowledged, [
    own
  ]);
  assert.equal(
    (await request("/api/desktop/notices", cookie, { client, events: Array(101).fill(own) }))
      .status,
    400
  );
  assert.equal((await request("/api/desktop/notices", cookie, { client, events: [] })).status, 400);
  assert.equal(
    (await request("/api/desktop/notices", cookie, { client: "bad", events: [own] })).status,
    422
  );
  assert.equal((await request("/api/desktop/notices?client=bad", cookie)).status, 400);
  await stop();
  await start();
  const resumed = await request(path, cookie);
  assert.deepEqual(resumed.data.events, [own], "Acceptance must not mark bell items read");
  assert.deepEqual(
    resumed.data.acknowledged,
    [own],
    "Acceptance must survive a real server restart"
  );
  assert.deepEqual(
    (await request(`/api/desktop/notices?client=${otherClient}`, cookie)).data.acknowledged,
    []
  );
  assert.equal(
    (await admin.query("SELECT count(*)::int AS n FROM app.desktop_notification_receipts")).rows[0]
      .n,
    1
  );
  assert.equal(
    (await admin.query("SELECT count(*)::int AS n FROM app.notification_reads")).rows[0].n,
    0
  );
  console.log(
    "PASS verified HTTPS: authenticated receipt write, retry idempotency, restart persistence, independent clients, foreign IDs omitted, bell items unread, invalid batches and origins refused"
  );
  await scope(member);
  assert.equal((await app.query("SELECT * FROM app.desktop_notification_receipts")).rowCount, 0);
  await app.query("ROLLBACK");
  async function rejectsForeignReceipt() {
    await scope(owner); // An admin has no private-data bypass.
    try {
      await app.query(
        "INSERT INTO app.desktop_notification_receipts(user_id,client_id,notification_id) VALUES($1,$2,$3)",
        [member, client, own]
      );
      return false;
    } catch (error) {
      assert.equal((error as { code?: string }).code, "42501");
      return true;
    } finally {
      await app.query("ROLLBACK");
    }
  }
  assert(await rejectsForeignReceipt(), "RLS must refuse another recipient's receipt");
  // Prove that this security assertion detects removal of the protection, on disposable data.
  await admin.query("ALTER TABLE app.desktop_notification_receipts DISABLE ROW LEVEL SECURITY");
  try {
    assert.equal(
      await rejectsForeignReceipt(),
      false,
      "Negative control did not reach the forbidden write"
    );
    console.log(
      "PASS negative control: removing receipt RLS allows the forbidden write and makes the isolation assertion fail"
    );
  } finally {
    await admin.query("ALTER TABLE app.desktop_notification_receipts ENABLE ROW LEVEL SECURITY");
  }
  assert(await rejectsForeignReceipt());
  await admin.query("DELETE FROM app.notifications WHERE id=$1", [own]);
  assert.equal(
    (await admin.query("SELECT count(*)::int AS n FROM app.desktop_notification_receipts")).rows[0]
      .n,
    0
  );
  console.log(
    "PASS recipient RLS including admin, protection-removal control, notification deletion cascades receipts"
  );
} finally {
  await stop();
  await app.end();
  await admin.end();
  execFileSync("devports", ["release", port]);
  rmSync(scratch, { recursive: true, force: true });
}
