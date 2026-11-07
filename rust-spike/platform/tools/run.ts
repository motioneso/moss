import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { getMossDatabaseUrls } from "@moss/db";
import { startReference } from "./reference.js";
import { runCases } from "./cases.js";

function command(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<void>((ok, fail) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`))));
  });
}
async function ready(url: string, child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Rust test host stopped");
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Test host startup deadline exceeded");
}
if (process.env.JARVIS_GATE_RUN !== "1")
  throw new Error("Refusing database tests outside verify-gate");
const ports: number[] = [];
function claim(label: string) {
  const port = Number(
    execFileSync("devports", ["claim", `js39-${process.pid}-${label}`], { encoding: "utf8" }).trim()
  );
  assert(port >= 5180 && port <= 5299);
  ports.push(port);
  return port;
}
const children: ChildProcess[] = [];
const scratch = mkdtempSync(join(tmpdir(), "moss-phase2b-"));
let closeReference: (() => Promise<void>) | undefined;
const provider = Fastify({ logger: false });
let captured: unknown;
let failing = false;
provider.all("/*", async (request, reply) => {
  captured = {
    path: request.url,
    body: request.body,
    credentialHeader:
      typeof (
        request.headers.authorization ??
        request.headers["x-api-key"] ??
        request.headers["x-goog-api-key"]
      ) === "string"
  };
  if (failing) return reply.code(500).send({ error: "SENTINEL-private-provider-error" });
  return {
    choices: [{ message: { content: "fixture reply" } }],
    content: [{ type: "text", text: "fixture reply" }],
    candidates: [{ content: { parts: [{ text: "fixture reply" }] } }]
  };
});
try {
  await command("pnpm", ["build:app-map"]);
  await command("pnpm", [
    "exec",
    "tsx",
    "rust-spike/platform/tools/export-fixtures.ts",
    join(scratch, "manifests.json")
  ]);
  await command("python3", ["rust-spike/platform/tools/check-boundaries.py"]);
  await command("python3", ["rust-spike/platform/tools/test-boundaries.py"]);
  await command("cargo", [
    "test",
    "--manifest-path",
    "rust-spike/platform/Cargo.toml",
    "--workspace"
  ]);
  const urls = getMossDatabaseUrls();
  await command(
    "cargo",
    [
      "test",
      "--manifest-path",
      "rust-spike/platform/Cargo.toml",
      "--test",
      "database",
      "--",
      "--ignored",
      "--nocapture"
    ],
    {
      ...process.env,
      JS39_APP_URL: urls.app,
      JS39_WORKER_URL: urls.worker,
      JS39_MIGRATION_URL: urls.migration,
      JS39_BOOTSTRAP_URL: urls.bootstrap
    }
  );
  await command("cargo", [
    "build",
    "--manifest-path",
    "rust-spike/platform/Cargo.toml",
    "--bin",
    "server"
  ]);
  // Claim immediately before binding so unrelated local processes have the
  // smallest possible opportunity to race a reservation they do not honor.
  const rustPort = claim("rust");
  const rust = spawn(resolve("rust-spike/platform/target/debug/server"), [String(rustPort)], {
    stdio: "inherit",
    env: process.env
  });
  children.push(rust);
  await ready(`http://127.0.0.1:${rustPort}`, rust);
  const tsPort = claim("reference");
  const apiPort = claim("api");
  closeReference = await startReference(tsPort, apiPort);
  const providerPort = claim("provider");
  await provider.listen({ host: "127.0.0.1", port: providerPort });
  const fixture = JSON.parse(readFileSync(join(scratch, "manifests.json"), "utf8"));
  await runCases({
    ts: `http://127.0.0.1:${tsPort}`,
    api: `http://127.0.0.1:${apiPort}`,
    rust: `http://127.0.0.1:${rustPort}`,
    provider: `http://127.0.0.1:${providerPort}`,
    fixture,
    capture: () => captured,
    setFailure: (value: boolean) => {
      failing = value;
    }
  });
} finally {
  await provider.close();
  await closeReference?.();
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
  }
  for (const port of ports) execFileSync("devports", ["release", String(port)]);
  rmSync(scratch, { recursive: true, force: true });
}
