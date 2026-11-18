import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const checks = spawnSync("modules/finance/tools/check.sh", {
  stdio: "inherit",
  env: process.env
});
if (checks.status !== 0) process.exit(checks.status ?? 1);
for (const suite of ["installed", "part25"]) {
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "modules/finance/host/Cargo.toml",
      "--test",
      suite,
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
        FINANCE_COMPONENT_WASM: `${process.env.CARGO_TARGET_DIR ?? "/tmp/moss-finance-host"}/module.wasm`
      }
    }
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
}

// Run security assertions with each guard removed, then restore and run the protected tests.
const controls = spawnSync("python3", ["modules/finance/tools/privacy-controls.py"], {
  stdio: "inherit",
  env: {
    ...process.env,
    JS48_APP_URL: urls.app,
    JS48_BOOTSTRAP_URL: urls.bootstrap,
    JS48_WORKER_URL: urls.worker,
    FINANCE_COMPONENT_WASM: `${process.env.CARGO_TARGET_DIR ?? "/tmp/moss-finance-host"}/module.wasm`
  }
});
process.exit(controls.status ?? 1);
