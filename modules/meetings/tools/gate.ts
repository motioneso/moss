import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const checks = spawnSync("modules/meetings/tools/check.sh", {
  stdio: "inherit",
  env: process.env
});
if (checks.status !== 0) process.exit(checks.status ?? 1);
// One cargo run per test file, in this order. The files share one database and
// the installed test expects it untouched, so it runs first.
for (const name of [
  "installed",
  "outputs",
  "recording",
  "transcripts",
  "exports",
  "reading",
  "ring"
]) {
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "modules/meetings/host/Cargo.toml",
      "--test",
      name,
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1"
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        JS48_APP_URL: urls.app,
        JS48_BOOTSTRAP_URL: urls.bootstrap,
        JS48_WORKER_URL: urls.worker,
        MEETINGS_COMPONENT_WASM: `${process.env.CARGO_TARGET_DIR ?? "/tmp/moss-meetings-host"}/module.wasm`,
        MEMORY_CORE_WASM: `${process.env.CARGO_TARGET_DIR ?? "/tmp/moss-meetings-host"}/memory-guest/wasm32-unknown-unknown/release/moss_memory.wasm`
      }
    }
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
}
