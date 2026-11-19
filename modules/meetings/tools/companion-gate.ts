/** Fresh moss-db schema proof; the regular Meetings gate covers device removal/reinstall. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
if (!process.env.CARGO_HOME) throw new Error("Set CARGO_HOME before cargo");
if (!process.env.MOSS_COMPANION_PG) throw new Error("Set MOSS_COMPANION_PG to a pgvector bundle");
const target = process.env.CARGO_TARGET_DIR ?? "/tmp/moss-meetings-host";
const env = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  MOSS_DB_PROGRAM: join(target, "debug/moss-db")
};
function cargo(args: string[]) {
  const run = spawnSync("cargo", ["+1.95.0", ...args], { stdio: "inherit", env });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
cargo([
  "build",
  "--locked",
  "--offline",
  "--manifest-path",
  "rust-spike/Cargo.toml",
  "-p",
  "bundled-db"
]);
cargo([
  "test",
  "--locked",
  "--offline",
  "--manifest-path",
  "rust-spike/module-host/Cargo.toml",
  "--test",
  "companion_tables",
  "--",
  "--ignored",
  "--nocapture",
  "--test-threads=1"
]);
