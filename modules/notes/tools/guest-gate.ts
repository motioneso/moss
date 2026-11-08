import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";
import { exportOracle } from "./export-oracle.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
if (!process.env.NOTES_COMPONENT) throw new Error("Build Notes and set NOTES_COMPONENT");
const component = await readFile(process.env.NOTES_COMPONENT);
console.log("Notes guest sha256:", createHash("sha256").update(component).digest("hex"));
const folder = await mkdtemp(join(tmpdir(), "moss-notes-guest-"));
const pinned = join(folder, "notes.wasm");
const urls = getMossDatabaseUrls();
let oracle: Awaited<ReturnType<typeof exportOracle>> | undefined;
try {
  await writeFile(pinned, component, { mode: 0o400 });
  oracle = await exportOracle();
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "modules/notes/tools/Cargo.toml",
      "--test",
      "database",
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1"
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NOTES_COMPONENT: pinned,
        NOTES_ORACLE: oracle.path,
        JS55_APP_URL: urls.app,
        JS55_WORKER_URL: urls.worker,
        JS55_BOOTSTRAP_URL: urls.bootstrap
      }
    }
  );
  process.exitCode = run.status ?? 1;
} finally {
  try {
    await oracle?.cleanup();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
