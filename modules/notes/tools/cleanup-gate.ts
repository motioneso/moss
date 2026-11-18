import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";
import { cleanupOracle } from "./cleanup-oracle.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const oracle = await cleanupOracle();
const folder = await mkdtemp(join(tmpdir(), "notes-cleanup-controls-"));
try {
  const urls = getMossDatabaseUrls();
  const env = {
    ...process.env,
    NOTES_CLEANUP_ORACLE: oracle.path,
    JS55_APP_URL: urls.app,
    JS55_WORKER_URL: urls.worker,
    JS55_BOOTSTRAP_URL: urls.bootstrap
  };
  const args = [
    "+1.95.0",
    "test",
    "--locked",
    "--offline",
    "--manifest-path",
    "modules/notes/tools/Cargo.toml",
    "--test",
    "cleanup",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ];
  process.exitCode = spawnSync("cargo", args, { stdio: "inherit", env }).status ?? 1;
  if (process.exitCode === 0)
    process.exitCode =
      spawnSync("python3", ["modules/notes/tools/cleanup-controls.py", folder], {
        stdio: "inherit",
        env
      }).status ?? 1;
} finally {
  await oracle.cleanup();
  await rm(folder, { recursive: true, force: true });
}
