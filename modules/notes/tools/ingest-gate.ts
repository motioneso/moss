import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
import { ingestOracle } from "./ingest-oracle.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const oracle = await ingestOracle();
try {
  const urls = getMossDatabaseUrls();
  const env = {
    ...process.env,
    NOTES_INGEST_ORACLE: oracle.path,
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
    "ingest",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ];
  process.exitCode = spawnSync("cargo", args, { stdio: "inherit", env }).status ?? 1;
} finally {
  await oracle.cleanup();
}
