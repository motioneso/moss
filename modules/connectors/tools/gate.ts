import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
import { connectorsControlArgs } from "./control-selection.js";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const selected = process.env.CONNECTORS_SUITE;
const available = [
  "package",
  "registry",
  "mail_probe",
  "sync_speed",
  "db",
  "google_sync",
  "google",
  "imap",
  "refresh",
  "outlook",
  "writes"
];
if (selected && !available.includes(selected)) throw new Error("Unknown Connectors test suite");
const suites = selected
  ? [selected]
  : (process.env.CONNECTORS_TESTS ?? "db,google_sync,google,imap,refresh,outlook,writes").split(
      ","
    );
const selectedSuites = suites.map((suite) => ({
  suite,
  controlArgs: connectorsControlArgs(suite, process.env.CONNECTORS_CONTROLS ?? "all")
}));
const urls = getMossDatabaseUrls();
const checks = spawnSync("modules/connectors/tools/check.sh", {
  stdio: "inherit",
  env: process.env
});
if (checks.status !== 0) process.exit(checks.status ?? 1);
const target = process.env.CARGO_TARGET_DIR ?? "/tmp/moss-connectors-host";
const wasm = `${target}/connectors-guest/wasm32-unknown-unknown/release/moss_connectors.wasm`;
const env = {
  ...process.env,
  JS48_APP_URL: urls.app,
  JS48_BOOTSTRAP_URL: urls.bootstrap,
  JS48_WORKER_URL: urls.worker,
  CONNECTORS_CORE_WASM: wasm
};
let status = 0;
for (const { suite, controlArgs } of selectedSuites) {
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "modules/connectors/host/Cargo.toml",
      "--test",
      suite,
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1",
      ...controlArgs
    ],
    { stdio: "inherit", env }
  );
  status = status || (run.status ?? 1);
}
process.exit(status);
