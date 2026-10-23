/** Run only through run-gate.sh: owns a throwaway database and short-lived dev server. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGateRunDatabaseAccess } from "@moss/db";
import type { FastifyInstance } from "fastify";

const execute = promisify(execFile);
assertGateRunDatabaseAccess(process.env);
const browserScript = process.env.VOCCI_LIVE_BROWSER_SCRIPT;
if (!browserScript)
  throw new Error("Set VOCCI_LIVE_BROWSER_SCRIPT to the private browser proof script");
const port = Number((await execute("devports", ["claim", "vocci-import-proof"])).stdout.trim());
const directory = await mkdtemp(join(tmpdir(), "moss-recording-live-"));
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.MOSS_VAULT_ROOT = join(directory, "vaults");
process.env.MOSS_EXTERNAL_MODULES_DIR = join(directory, "modules");
process.env.MOSS_AUTH_URL = `http://127.0.0.1:${port}`;
process.env.BETTER_AUTH_URL = process.env.MOSS_AUTH_URL;
let server: FastifyInstance | undefined;
let worker: ChildProcess | undefined;
let workerExited: Promise<void> | undefined;
try {
  const { createApiServer } = await import("../apps/api/src/server.js");
  server = createApiServer({ logger: false });
  await server.listen({ host: "127.0.0.1", port });
  // Imports transcribe in the API; analysis runs in the canonical worker process.
  // Both inherit only this gate's throwaway database and vault configuration.
  worker = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/worker.ts"], {
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const child = worker;
  workerExited = new Promise((resolve) => child.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Worker startup timed out")), 60_000);
    let pending = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("error", failed);
      child.off("exit", exited);
      child.stdout?.off("data", data);
      // Keep draining without exposing worker logs or private content.
      child.stdout?.resume();
      if (error) reject(error);
      else resolve();
    };
    const failed = () => finish(new Error("Worker could not start"));
    const exited = () => finish(new Error("Worker exited before readiness"));
    const data = (chunk: Buffer) => {
      pending = (pending + chunk.toString()).slice(-4096);
      if (pending.includes("Jarv1s worker listening on")) finish();
    };
    child.once("error", failed);
    child.once("exit", exited);
    child.stdout?.on("data", data);
  });
  const result = await execute("python3", [browserScript], {
    env: { ...process.env, VOCCI_LIVE_URL: `http://127.0.0.1:${port}` },
    // Native sign-in and existing ring backlog can consume most of 15 minutes.
    // Keep a bounded window for fresh samples and browser/device cleanup too.
    timeout: 1_800_000,
    maxBuffer: 128 * 1024
  });
  process.stdout.write(result.stdout);
} catch {
  // Browser artifacts hold detailed, private diagnostics. Never dump captured transcript DOM.
  throw new Error("Recording live proof failed; inspect private browser proof artifacts");
} finally {
  try {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGTERM");
      const forcedStop = setTimeout(() => worker?.kill("SIGKILL"), 15_000);
      await workerExited;
      clearTimeout(forcedStop);
    }
  } finally {
    try {
      await server?.close();
    } finally {
      await Promise.all([
        execute("devports", ["release", String(port)]),
        rm(directory, { recursive: true, force: true })
      ]);
    }
  }
}
