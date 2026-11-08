import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getMossDatabaseUrls } from "@moss/db";
import { peopleOracle } from "./people-oracle.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
if (!process.env.JS50_PEOPLE_COMPONENT)
  throw new Error("Build People component and set JS50_PEOPLE_COMPONENT");
console.log(
  "Compiled People component sha256:",
  createHash("sha256")
    .update(await readFile(process.env.JS50_PEOPLE_COMPONENT))
    .digest("hex")
);
const urls = getMossDatabaseUrls();
const oracle = await peopleOracle();
try {
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "rust-spike/module-host/Cargo.toml",
      "--test",
      "people_privacy",
      "--test",
      "people_persistence",
      "--test",
      "people_guest_database",
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1"
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        JS43_APP_URL: urls.app,
        JS43_WORKER_URL: urls.worker,
        JS43_BOOTSTRAP_URL: urls.bootstrap,
        JS50_PEOPLE_ORACLE: oracle.path
      }
    }
  );
  process.exitCode = run.status ?? 1;
} finally {
  await oracle.cleanup();
}
