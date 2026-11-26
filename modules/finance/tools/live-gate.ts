/** Real Rust server over HTTPS with the installed Finance package. Run through verify-gate. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR", "JS302_FINANCE_PACKAGE"]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
const urls = getMossDatabaseUrls();
const target = process.env.CARGO_TARGET_DIR!;
const address = Object.values(networkInterfaces())
  .flat()
  .find((n) => n?.family === "IPv4" && !n.internal)?.address;
if (!address) throw new Error("The live check needs a non-loopback network address");
const sharedDir = join(target, "finance-shared");
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
  "moss-server"
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
const realBank = process.env.JS325_PLAID === "1";
if (!realBank) {
  cargo([
    "build",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/standins/Cargo.toml",
    "--bin",
    "fake-plaid"
  ]);
}
cargo(
  [
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    realBank ? "finance_plaid_live" : "finance_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
    MOSS_MODULE_SHARED_DIR: sharedDir,
    JS290_PROOF_ADDRESS: address,
    JS43_APP_URL: urls.app,
    JS43_WORKER_URL: urls.worker,
    JS43_BOOTSTRAP_URL: urls.bootstrap,
    JS170_AUTH_URL: urls.auth,
    JS305_FAKE_PLAID: join(target, "debug/fake-plaid"),
    ...(realBank
      ? {
          JS325_PLAID_KEYS: join(process.env.HOME!, ".config/moss-proof/plaid-sandbox"),
          JS325_RELAY: join(process.cwd(), "modules/finance/tools/sandbox-relay.py"),
          JS325_DIR: process.env.JS325_DIR!
        }
      : {}),
    JS170_SERVER: join(target, "debug/moss-server"),
    JS170_CERTIFICATE: join(target, "debug/moss-network")
  }
);
