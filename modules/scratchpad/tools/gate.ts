import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const targetDir = process.env.CARGO_TARGET_DIR ?? "/tmp/moss-scratchpad-host";
const checks = spawnSync("modules/scratchpad/tools/check.sh", {
  stdio: "inherit",
  env: process.env
});
if (checks.status !== 0) process.exit(checks.status ?? 1);
// One cargo run per test file, in this order. The files share one database and
// the installed test expects it untouched, so it runs first.
for (const name of ["package", "installed"]) {
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "modules/scratchpad/host/Cargo.toml",
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
        SCRATCHPAD_COMPONENT_WASM: `${targetDir}/module.wasm`
      }
    }
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
}
