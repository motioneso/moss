import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { checkServerIdentity } from "node:tls";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { getMossDatabaseUrls } from "../../../packages/db/src/urls.js";

assert(process.env.JARVIS_GATE_RUN === "1", "Database checks require verify-gate");
const root = resolve(".");
const out = process.env.JS44_PROOF_DIR ?? mkdtempSync(join(tmpdir(), "moss-network-proof-"));
mkdirSync(out, { recursive: true, mode: 0o700 });
const port = Number(
  execFileSync("devports", ["claim", `js44-live-${process.pid}`], { encoding: "utf8" }).trim()
);
const remote = Object.values(networkInterfaces())
  .flat()
  .find((n) => n?.family === "IPv4" && !n.internal)?.address;
assert(remote, "A second network address is required for the live proof");
const local = `https://127.0.0.1:${port}`;
const second = `https://${remote}:${port}`;
const origins = [local, `https://localhost:${port}`, second];
const urls = getMossDatabaseUrls();
const credentialFile = join(out, "credentials.json");
const configFile = join(out, "network.json");
const certificate = join(out, "tls", "certificate.pem");
const logFile = join(out, "server.log");
const password = randomBytes(32).toString("hex");
const email = `rust-owner-${randomBytes(6).toString("hex")}@example.com`;
const secrets: string[] = [password];
writeFileSync(
  credentialFile,
  JSON.stringify({
    app_url: urls.app,
    auth_url: urls.auth,
    auth_secret: randomBytes(48).toString("hex"),
    connector_key: randomBytes(32).toString("hex")
  }),
  { mode: 0o600 }
);
writeFileSync(
  configFile,
  JSON.stringify({
    listen: `0.0.0.0:${port}`,
    origins,
    sharing: false,
    certificate,
    private_key: join(out, "tls", "key.pem"),
    credentials: credentialFile
  }),
  { mode: 0o600 }
);
execFileSync(
  "cargo",
  [
    "+1.95.0",
    "run",
    "--offline",
    "--quiet",
    "--manifest-path",
    "rust-spike/network/Cargo.toml",
    "--",
    "local-certificate",
    join(out, "tls"),
    ...origins
  ],
  { stdio: ["ignore", "ignore", "inherit"] }
);
const ca = readFileSync(certificate);
interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  bytes: Buffer;
}
async function request(
  base: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
    peer?: string;
  } = {}
): Promise<Reply> {
  const url = new URL(base);
  const data = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((ok, fail) => {
    const req = https.request(
      {
        agent: false,
        hostname: url.hostname,
        port: url.port,
        path,
        method: options.method ?? "GET",
        ca,
        rejectUnauthorized: true,
        servername: "localhost",
        checkServerIdentity: (_hostname, cert) => checkServerIdentity(url.hostname, cert),
        localAddress: options.peer,
        headers: {
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(data))
              }
            : {}),
          ...(options.method ? { origin: base } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...options.headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size > 2_000_000) req.destroy(new Error("Response limit"));
        });
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          ok({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: bytes.toString("utf8"),
            bytes
          });
        });
      }
    );
    req.setTimeout(30_000, () => req.destroy(new Error("Request deadline")));
    req.on("error", fail);
    if (data) req.write(data);
    req.end();
  });
}
function cookie(reply: Reply): string {
  const value = reply.headers["set-cookie"]
    ?.find((h) => h.startsWith("__Secure-better-auth.session_token="))
    ?.split(";")[0];
  assert(value, "Sign-in must set its secure cookie");
  const attributes = reply.headers["set-cookie"]!.join(";");
  assert(
    attributes.includes("HttpOnly") &&
      attributes.includes("Secure") &&
      attributes.includes("SameSite=Lax"),
    "Safe cookie attributes required"
  );
  const raw = decodeURIComponent(value.slice(value.indexOf("=") + 1)).split(".")[0];
  assert(raw, "Signed cookie must contain a session token");
  secrets.push(raw, value);
  assert(
    !reply.body.includes(raw) && !reply.body.includes('"token"'),
    "Session token appeared in browser JSON"
  );
  return value;
}
function scanLogs() {
  const text = readFileSync(logFile, "utf8");
  assert(
    secrets.every((value) => !text.includes(value)),
    "Session token or password appeared in server logs"
  );
}
let server: ChildProcess | undefined;
const db = new pg.Client({ connectionString: urls.auth });
try {
  await db.connect();
  const fd = openSync(logFile, "w", 0o600);
  server = spawn(
    process.env.JS44_SERVER_BIN ?? join(root, "rust-spike/shell/target/debug/moss-shell"),
    ["serve", "--network", configFile, "--web", process.env.JS44_WEB ?? "/tmp/js44-web"],
    { stdio: ["ignore", fd, fd], env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY } }
  );
  closeSync(fd);
  for (let n = 0; n < 150; n++) {
    assert(server.exitCode === null, "Secure shell stopped at startup");
    try {
      if ((await request(local, "/sign-in")).status === 200) break;
    } catch {
      /* bounded startup only */
    }
    await delay(100);
    assert(n < 149, "HTTPS listener did not start");
  }
  assert.equal(
    (await request(local, "/api/me", { headers: { host: `rebind.example:${port}` } })).status,
    421
  );
  assert.equal(
    (await request(local, "/api/me", { headers: { origin: "https://evil.example" } })).status,
    403
  );
  assert.equal(
    (
      await request(local, "/api/auth/sign-in/email", {
        method: "POST",
        body: {},
        headers: { origin: "null" }
      })
    ).status,
    403
  );
  console.log("PASS wrong Host, wrong origin and null origin refused by the real HTTPS listener");
  for (const path of [
    "/api/me",
    "/api/shell",
    "/api/today",
    "/api/chat/thread",
    "/api/network",
    "/api/network/certificate"
  ]) {
    assert.equal(
      (await request(local, path)).status,
      401,
      "Signed-out request reached private data"
    );
  }
  for (const path of ["/today", "/app.js", "/app_bg.wasm", "/unknown-module"]) {
    assert.equal(
      (await request(local, path)).status,
      303,
      "Signed-out request reached an app page or app file"
    );
  }
  console.log("PASS signed-out API, chat, private page and app files refused");
  assert.equal((await request(second, "/sign-in")).status, 403);
  console.log("PASS second network address refused while sharing is off");
  const signup = await request(local, "/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Rust proof owner", email, password }
  });
  assert.equal(signup.status, 200, "Local first-owner setup failed");
  const localCookie = cookie(signup);
  const me = await request(local, "/api/me", { cookie: localCookie });
  assert.equal(me.status, 200);
  const person = JSON.parse(me.body);
  assert(
    person.user?.isBootstrapOwner === true || person.isBootstrapOwner === true,
    "First account is not the bootstrap owner"
  );
  assert.equal(
    (
      await request(local, "/api/auth/sign-up/email", {
        method: "POST",
        body: { name: "Too late", email: "late@example.com", password }
      })
    ).status,
    403
  );
  const stored = await db.query(
    "SELECT password FROM app.auth_accounts WHERE user_id = (SELECT id FROM app.users WHERE email=$1)",
    [email]
  );
  assert(
    stored.rows.length === 1 &&
      stored.rows[0].password !== password &&
      /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored.rows[0].password),
    "Password was not stored in the existing scrypt format"
  );
  console.log(
    "PASS first local owner created, setup closed, password stored as a hash, token absent from browser JSON"
  );
  assert.equal(
    (
      await request(local, "/api/network", {
        method: "PUT",
        cookie: localCookie,
        body: { sharing: true }
      })
    ).status,
    200
  );
  assert(
    JSON.parse(readFileSync(configFile, "utf8")).sharing === true,
    "Sharing was not persisted"
  );
  assert.equal(
    (
      await request(second, "/api/auth/sign-up/email", {
        method: "POST",
        body: { name: "Remote", email: "remote@example.com", password }
      })
    ).status,
    403
  );
  const status = await request(local, "/api/network", { cookie: localCookie });
  const certificateReply = await request(local, "/api/network/certificate", {
    cookie: localCookie
  });
  assert.equal(certificateReply.status, 200);
  assert.equal(certificateReply.headers["content-type"], "application/pkix-cert");
  assert.deepEqual(
    certificateReply.bytes,
    new X509Certificate(ca).raw,
    "Download must contain exactly the public leaf certificate"
  );
  assert.equal(
    JSON.parse(status.body).fingerprint.replaceAll(" ", ""),
    new X509Certificate(ca).fingerprint256
  );
  console.log(
    "PASS sharing page supplies the actual public certificate fingerprint and certificate download"
  );
  const remoteLogin = await request(second, "/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password }
  });
  assert.equal(remoteLogin.status, 200, "Real sign-in through the second network address failed");
  const remoteCookie = cookie(remoteLogin);
  assert.equal((await request(second, "/api/me", { cookie: remoteCookie })).status, 200);
  assert.equal((await request(second, "/api/today", { cookie: remoteCookie })).status, 200);
  const shell = await request(second, "/api/shell", { cookie: remoteCookie });
  assert.equal(shell.status, 200);
  assert.equal(JSON.parse(shell.body).account.display_name, "Rust proof owner");
  // Four incomplete bodies must never occupy the four password-check slots.
  const stalled = Array.from({ length: 4 }, () => {
    const req = https.request({
      hostname: "127.0.0.1",
      port,
      localAddress: "127.0.0.3",
      ca,
      rejectUnauthorized: true,
      servername: "localhost",
      method: "POST",
      path: "/api/auth/sign-in/email",
      headers: { origin: local, "content-type": "application/json", "content-length": "100" }
    });
    req.on("error", () => {});
    req.flushHeaders();
    return req;
  });
  try {
    await delay(300);
    const normal = await request(local, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password }
    });
    assert.equal(normal.status, 200, "Stalled bodies blocked normal sign-in");
    cookie(normal);
    console.log("PASS four stalled sign-in bodies do not block a complete password sign-in");
  } finally {
    for (const req of stalled) req.destroy();
  }

  console.log(
    "PASS second network address: real password sign-in, private account and Today read over verified TLS"
  );
  assert.equal(
    (
      await request(second, "/api/network", {
        method: "PUT",
        cookie: remoteCookie,
        body: { sharing: false },
        headers: { origin: local }
      })
    ).status,
    403
  );
  assert.equal(
    (
      await request(second, "/api/network", {
        method: "PUT",
        cookie: remoteCookie,
        body: { sharing: false },
        headers: { "sec-fetch-site": "cross-site" }
      })
    ).status,
    403
  );
  const incompleteStarted = Date.now();
  try {
    const reply = await request(local, "/api/auth/sign-in/email", {
      method: "POST",
      peer: "127.0.0.4",
      headers: { "content-length": "100", "content-type": "application/json" }
    });
    assert.equal(reply.status, 408, "Incomplete sign-in body did not reach its deadline");
  } catch (error) {
    // Hyper may close an incomplete HTTP/1 request when its body is dropped at the deadline.
    assert(
      error instanceof Error && "code" in error && error.code === "ECONNRESET",
      "Incomplete body failed unexpectedly"
    );
  }
  assert(
    Date.now() - incompleteStarted >= 2500 && Date.now() - incompleteStarted < 10000,
    "Incomplete sign-in connection did not close at its three-second deadline"
  );
  console.log("PASS incomplete sign-in body is refused at its three-second deadline");
  try {
    const oversized = await request(local, "/api/auth/sign-in/email", {
      method: "POST",
      peer: "127.0.0.4",
      body: { padding: "x".repeat(17000) }
    });
    assert.equal(oversized.status, 413, "Oversized sign-in body was not refused");
  } catch (error) {
    // Closing a connection with an unread, rejected body is also a safe HTTP refusal.
    assert(
      error instanceof Error && "code" in error && error.code === "ECONNRESET",
      "Oversized body failed unexpectedly"
    );
  }
  assert(
    new X509Certificate(ca).keyUsage?.includes("1.3.6.1.5.5.7.3.1"),
    "Local certificate lacks serverAuth usage"
  );
  console.log(
    "PASS incomplete and oversized sign-in bodies refused; local certificate declares serverAuth"
  );
  const token = secrets[secrets.length - 2];
  assert(token, "A real sign-in token is required for the log probes");
  await request(second, `/private/${token}?session=${token}`, {
    cookie: remoteCookie,
    headers: { "user-agent": token }
  });
  await request(second, `/api/me?session=${token}`, { cookie: remoteCookie });
  scanLogs();
  console.log(
    "PASS real session token absent from logs after cookie, path, query and header probes"
  );
  assert.equal(
    (
      await request(second, "/api/auth/sign-out", {
        method: "POST",
        cookie: remoteCookie,
        body: {}
      })
    ).status,
    200
  );
  assert.equal((await request(second, "/api/me", { cookie: remoteCookie })).status, 401);
  assert.equal(
    (
      await request(local, "/api/network", {
        method: "PUT",
        cookie: localCookie,
        body: { sharing: false }
      })
    ).status,
    200
  );
  assert.equal((await request(second, "/api/me", { cookie: localCookie })).status, 403);
  console.log(
    "PASS cross-site writes refused, sign-out revoked the session, disabling sharing cut off remote reads"
  );
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (
        await request(local, "/api/auth/sign-in/email", {
          method: "POST",
          peer: "127.0.0.2",
          body: { email, password: "incorrect-password" },
          headers: { "x-forwarded-for": `192.0.2.${i + 1}` }
        })
      ).status,
      401
    );
  }
  const limited = await request(local, "/api/auth/sign-in/email", {
    method: "POST",
    peer: "127.0.0.2",
    body: { email, password },
    headers: { "x-forwarded-for": "192.0.2.99" }
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  scanLogs();
  console.log("PASS sign-in rate limit uses the real peer and ignores forged forwarded headers");
  if (process.env.JS44_HOLD === "1") {
    writeFileSync(
      join(out, "browser-fixture.json"),
      JSON.stringify({ local, second, email, password }),
      { mode: 0o600 }
    );
    writeFileSync(join(out, "browser-ready"), "ready", { mode: 0o600 });
    console.log(
      "READY browser proof; isolated server remains running until browser-finished appears"
    );
    for (let i = 0; i < 1200 && !existsSync(join(out, "browser-finished")); i++) await delay(1000);
    assert(existsSync(join(out, "browser-finished")), "Browser proof completion deadline exceeded");
    scanLogs();
    console.log("PASS browser proof completed and final server log scan stayed clean");
  }
} finally {
  await db.end();
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((ok) => server!.once("exit", () => ok()));
    server.kill("SIGTERM");
    await exited;
  }
  execFileSync("devports", ["release", String(port)], { stdio: "ignore" });
}
