// Live proof for clickable alerts, saved-server routing, one window per folder and the stop
// request file. Run only through click-gate.sh and verify-gate: all data is disposable.
// The desktop's alert service is a stand-in (fake_notification_daemon.py); every Moss program,
// the HTTPS server and the database are real.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { X509Certificate, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { getMossDatabaseUrls } from "../../../packages/db/src/urls.js";

assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
const here = dirname(fileURLToPath(import.meta.url));
const urls = getMossDatabaseUrls();
const scratch = mkdtempSync(join(tmpdir(), "moss-click-live-"));
const proof = process.env.PROOF_DIR ?? join(scratch, "proof");
mkdirSync(proof, { recursive: true });
const target = process.env.CARGO_TARGET_DIR!;
assert(target, "Use a task-owned Cargo target");
const port = execFileSync("devports", ["claim", `js203-click-${process.pid}`], {
  encoding: "utf8"
}).trim();
const origin = `https://localhost:${port}`;
const inst = join(scratch, "instance");
const data = join(scratch, "app-data");
const install = join(scratch, "install");
const certificate = join(inst, "tls/certificate.pem");
const web = join(scratch, "web");
const display = `:${90 + (process.pid % 500)}`;
const bus = `unix:path=${join(scratch, "bus")}`;
const daemonLog = join(scratch, "alerts.jsonl");
const children: ChildProcess[] = [];
const admin = new pg.Client({ connectionString: urls.bootstrap });
let ca: Buffer;
let server: ChildProcess | undefined;
const env = {
  PATH: process.env.PATH,
  DISPLAY: display,
  DBUS_SESSION_BUS_ADDRESS: bus,
  HOME: scratch
};

function launch(cmd: string, args: string[], log: string, extra: Record<string, string> = {}) {
  const fd = openSync(join(scratch, log), "a", 0o600);
  const child = spawn(cmd, args, { stdio: ["ignore", fd, fd], env: { ...env, ...extra } });
  closeSync(fd);
  children.push(child);
  return child;
}
function sh(cmd: string, args: string[], input?: string) {
  return execFileSync(cmd, args, { env, encoding: "utf8", input }).trim();
}
async function request(path: string, cookie?: string, body?: unknown) {
  return new Promise<{ status: number; data: Record<string, unknown>; cookie: string }>(
    (resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        origin + path,
        {
          ca,
          agent: false,
          method: bytes ? "POST" : "GET",
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(bytes
              ? {
                  origin,
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(bytes)
                }
              : {})
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
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
async function until<T>(what: string, check: () => T | undefined | false, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = check();
    if (found) return found;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
function alerts(): { id: number; title: string; body: string; actions: string[] }[] {
  return existsSync(daemonLog)
    ? readFileSync(daemonLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}
function windows() {
  try {
    return sh("xdotool", ["search", "--onlyvisible", "--name", "Moss"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
function shot(name: string) {
  const xwd = join(scratch, `${name}.xwd`);
  sh("xwd", ["-root", "-silent", "-out", xwd]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", xwd, join(proof, `${name}.png`)]);
}
// The fixture page paints its background by path: /tasks red, /notes green, /today blue.
function pageColour() {
  const xwd = join(scratch, "probe.xwd");
  sh("xwd", ["-root", "-silent", "-out", xwd]);
  const raw = execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    xwd,
    "-vf",
    "crop=1:1:900:600",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-"
  ]);
  const [r, g, b] = raw;
  return r > 200 && g < 60 && b < 60
    ? "tasks"
    : g > 200 && r < 60 && b < 60
      ? "notes"
      : b > 200 && r < 60 && g < 60
        ? "today"
        : "other";
}
function moss(args: string[], log: string) {
  return launch(join(target, "debug/moss-app"), [...args], log);
}
async function startServer() {
  server = launch(
    join(target, "debug/moss-shell"),
    ["serve", "--instance", inst, "--web", web],
    "server.log"
  );
  for (let i = 0; i < 100; i++) {
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

try {
  for (const d of [web, install, join(install, "web"), inst]) mkdirSync(d, { recursive: true });
  mkdirSync(data, { mode: 0o700 }); // the app refuses a data folder others can read
  writeFileSync(
    join(web, "index.html"),
    `<!doctype html><title>Moss proof page</title><body style="font:64px sans-serif;padding:40px">` +
      `<div>PAGE:</div><div id=p></div><script src="/page.js"></script>`
  );
  writeFileSync(
    join(web, "page.js"),
    `document.getElementById("p").textContent=location.pathname;` +
      `document.body.style.background=({"/tasks":"#f00","/notes":"#0f0","/today":"#00f"})[location.pathname]||"#fff"`
  );
  const credentials = join(scratch, "credentials.json");
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
    join(inst, "network.json"),
    JSON.stringify({
      listen: `127.0.0.1:${port}`,
      origins: [origin],
      sharing: false,
      certificate,
      private_key: join(inst, "tls/key.pem"),
      credentials
    }),
    { mode: 0o600 }
  );
  execFileSync(
    join(target, "debug/moss-network"),
    ["local-certificate", join(inst, "tls"), origin],
    {
      stdio: "ignore"
    }
  );
  ca = readFileSync(certificate);
  const x509 = new X509Certificate(ca);
  const pin = x509.fingerprint256; // "AA:BB:..." -> the app's "AA: BB: ..." form
  const appPin = pin.split(":").join(": ");
  await admin.connect();

  // The desktop stand-ins: a screen, a message bus and an alert service.
  launch("Xvfb", [display, "-screen", "0", "1100x780x24", "-nolisten", "tcp"], "xvfb.log");
  launch("dbus-daemon", ["--session", `--address=${bus}`, "--nofork"], "dbus.log");
  await until("screen", () => existsSync(`/tmp/.X11-unix/X${display.slice(1)}`));
  await until("bus", () => existsSync(join(scratch, "bus")));
  launch(
    "python3",
    ["-I", join(here, "fake_notification_daemon.py"), daemonLog, scratch],
    "daemon.log"
  );
  await until("alert service", () => existsSync(join(scratch, "daemon-ready")));

  await startServer();
  const signup = await request("/api/auth/sign-up/email", undefined, {
    name: "Click proof owner",
    email: "click-proof@example.test",
    password: "click-proof-password-1"
  });
  assert.equal(signup.status, 200, "Real owner setup");
  const cookie = signup.cookie;
  const owner = (await admin.query("SELECT id FROM app.users WHERE is_instance_admin=true")).rows[0]
    .id as string;
  const client = randomUUID();
  const registered = await request("/api/desktop/notifier", cookie, { client });
  assert.equal(registered.status, 200);
  const token = registered.data.token as string;

  const serverId = "proof-server";
  mkdirSync(join(data, "app"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(data, "app/servers.json"),
    JSON.stringify({
      last: serverId,
      remotes: [{ id: serverId, name: "Proof server", origin, pin: appPin }]
    }),
    { mode: 0o600 }
  );
  const base = ["--data", data];
  execFileSync(
    join(target, "debug/moss-app"),
    [
      "notifier",
      "add",
      ...base,
      "--server",
      serverId,
      "--origin",
      origin,
      "--pin",
      appPin,
      "--client",
      client,
      "--token",
      token
    ],
    { env }
  );
  async function post(title: string, href: string) {
    await admin.query(
      "INSERT INTO app.notifications(id,recipient_user_id,title,body,href) VALUES($1,$2,$3,'Proof body',$4)",
      [randomUUID(), owner, title, href]
    );
  }
  const click = (id = "") => writeFileSync(join(scratch, "click"), String(id));
  const requestFile = join(data, "open-request.json");
  const notifier = launch(
    join(target, "debug/moss-app"),
    ["notifier", "run", ...base],
    "notifier.log"
  );

  // 1. No window is open. A clicked alert starts one on the right server and page.
  await post("Proof one", "/tasks");
  await post("Proof two", "/notes");
  const first = await until("first alert", () => alerts().find((a) => a.title === "Proof one"));
  assert.deepEqual(first.actions, ["default", "Open"], "the alert offers a click action");
  assert.equal(windows().length, 0, "no window before the click");
  await until("second alert", () => alerts().find((a) => a.title === "Proof two"));
  click(first.id);
  await until("window started by the click", () => windows().length > 0, 40000);
  await until("request consumed", () => !existsSync(requestFile));
  console.log("PASS click with no window open starts the app and consumes the open request");

  // The first page is the sign-in screen; sign in once so later pages show their own path.
  await delay(3000);
  const win = windows()[0];
  sh("xdotool", ["windowsize", win, "1100", "780", "windowmove", win, "0", "0"]);
  shot("1-after-first-click");
  sh("xdotool", ["mousemove", "550", "400", "click", "1"]);
  console.log("SIGNIN-ATTEMPT");
  for (const step of [
    ["key", "Tab"],
    ["type", "click-proof@example.test"],
    ["key", "Tab"],
    ["type", "click-proof-password-1"],
    ["key", "Return"]
  ]) {
    sh("xdotool", step);
    await delay(200);
  }
  await delay(3000);
  shot("2-after-sign-in");
  assert.equal(pageColour(), "today", "signed in, the window shows the landing page");

  // 2. Window open and signed in: a click on a second alert switches the page, no second window.
  const before = windows().length;
  click(alerts().find((a) => a.title === "Proof two")!.id);
  await until("page switch", () => !existsSync(requestFile));
  await delay(2500);
  shot("3-after-second-click");
  for (let i = 0; i < 10 && pageColour() !== "notes"; i++) await delay(1000);
  shot("3b-later");
  assert.equal(pageColour(), "notes", "the click moved the open window to the alert's page");
  assert.equal(windows().length, before, "no second window");
  console.log("PASS click with the window open routes it without a second window");

  // 3. Starting the app again does not make a second window.
  const second = moss(base, "second.log");
  await until("second launch exits", () => second.exitCode !== null, 15000);
  assert.equal(second.exitCode, 0);
  assert.equal(windows().length, before, "still one window");
  console.log("PASS a second launch exits at once and leaves one window");

  // 4. The stop request file: a stale request is ignored, the right one stops the server.
  const running = JSON.parse(readFileSync(join(inst, "running.json"), "utf8"));
  writeFileSync(join(inst, "stop-request"), String(running.pid + 1), { mode: 0o600 });
  await delay(1500);
  assert.equal(server!.exitCode, null, "a request naming another process must not stop the server");
  writeFileSync(join(inst, "stop-request"), String(running.pid), { mode: 0o600 });
  await until("server stop", () => server!.exitCode !== null, 15000);
  assert(!existsSync(join(inst, "stop-request")));
  console.log("PASS stop request file: stale request ignored, request naming the server stops it");
  notifier.kill();
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  for (const child of children.reverse()) if (child.exitCode === null) child.kill("SIGKILL");
  try {
    execFileSync("pkill", ["-f", scratch]);
  } catch {
    /* none left */
  }
  await admin.end().catch(() => {});
  execFileSync("devports", ["release", port]);
  if (!process.env.PROOF_DIR) rmSync(scratch, { recursive: true, force: true });
  else console.log("kept scratch", scratch);
}
