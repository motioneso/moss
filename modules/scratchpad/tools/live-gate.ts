/** Real Rust server over HTTPS with the installed Scratchpad package. Run through verify-gate. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR", "JS286_SCRATCHPAD_PACKAGE"]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
const urls = getMossDatabaseUrls();
const target = process.env.CARGO_TARGET_DIR!;
const sharedDir = join(target, "scratchpad-shared");
if (
  spawnSync("python3", ["rust-spike/module-ui/build-assets.py", sharedDir], { stdio: "inherit" })
    .status !== 0
) {
  throw new Error("shared screen assets did not build");
}
function cargo(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync("cargo", ["+1.95.0", ...args], {
    stdio: "inherit",
    env: { ...process.env, ...extra }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
cargo([
  "build",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/shell/Cargo.toml",
  "-p",
  "moss-shell"
]);
cargo([
  "build",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/network/Cargo.toml",
  "--bin",
  "moss-network"
]);
cargo(
  [
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "scratchpad_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
    MOSS_MODULE_SHARED_DIR: sharedDir,
    JS43_APP_URL: urls.app,
    JS43_WORKER_URL: urls.worker,
    JS43_BOOTSTRAP_URL: urls.bootstrap,
    JS170_AUTH_URL: urls.auth,
    JS170_SERVER: join(target, "debug/moss-shell"),
    JS170_CERTIFICATE: join(target, "debug/moss-network")
  }
);
