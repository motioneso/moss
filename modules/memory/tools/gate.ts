import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const checks = spawnSync("modules/memory/tools/check.sh", {
  stdio: "inherit",
  env: process.env
});
if (checks.status !== 0) process.exit(checks.status ?? 1);
const env = {
  ...process.env,
  JS48_APP_URL: urls.app,
  JS48_BOOTSTRAP_URL: urls.bootstrap,
  MEMORY_CORE_WASM: `${process.env.CARGO_TARGET_DIR ?? "/tmp/moss-memory-host"}/memory-guest/wasm32-unknown-unknown/release/moss_memory.wasm`
};
let status = 0;
for (const suite of (process.env.MEMORY_SUITES ?? "db,dashboard").split(",")) {
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "modules/memory/host/Cargo.toml",
      "--test",
      suite,
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1"
    ],
    { stdio: "inherit", env }
  );
  status = status || (run.status ?? 1);
}
process.exit(status);
