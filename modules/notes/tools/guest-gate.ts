import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";
import { settingsOracle } from "./settings-oracle.js";
import { approvalOracle } from "./approval-oracle.js";
import { exportOracle } from "./export-oracle.js";
import { searchOracle } from "./search-oracle.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
if (!process.env.NOTES_COMPONENT) throw new Error("Build Notes and set NOTES_COMPONENT");
const component = await readFile(process.env.NOTES_COMPONENT);
console.log("Notes guest sha256:", createHash("sha256").update(component).digest("hex"));
const folder = await mkdtemp(join(tmpdir(), "moss-notes-guest-"));
const pinned = join(folder, "notes.wasm");
const urls = getMossDatabaseUrls();
let search: Awaited<ReturnType<typeof searchOracle>> | undefined;
let approval: Awaited<ReturnType<typeof approvalOracle>> | undefined;
let settings: Awaited<ReturnType<typeof settingsOracle>> | undefined;
let oracle: Awaited<ReturnType<typeof exportOracle>> | undefined;
try {
  await writeFile(pinned, component, { mode: 0o400 });
  oracle = await exportOracle();
  settings = await settingsOracle();
  // The export test installs the host schemas. Keep approval after the original
  // database/settings binaries rather than relying on Cargo's binary ordering.
  function run(tests: string[]) {
    return (
      spawnSync(
        "cargo",
        [
          "+1.95.0",
          "test",
          "--locked",
          "--offline",
          "--manifest-path",
          "modules/notes/tools/Cargo.toml",
          ...tests.flatMap((test) => ["--test", test]),
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
            NOTES_ORACLE: oracle?.path,
            NOTES_SETTINGS_ORACLE: settings?.path,
            NOTES_APPROVAL_ORACLE: approval?.path,
            NOTES_SEARCH_ORACLE: search?.path,
            JS55_APP_URL: urls.app,
            JS55_WORKER_URL: urls.worker,
            JS55_BOOTSTRAP_URL: urls.bootstrap
          }
        }
      ).status ?? 1
    );
  }
  process.exitCode = run(["database", "settings"]);
  if (process.exitCode === 0) {
    // Those accounts also own notes-source-path preferences. Remove them before
    // the RLS-removal control so query_opt cannot fail on multiple visible rows.
    await settings.cleanup();
    settings = undefined;
    await oracle.cleanup();
    oracle = undefined;
    approval = await approvalOracle();
    process.exitCode = run(["approval"]);
  }
  if (process.exitCode === 0) {
    await approval?.cleanup();
    approval = undefined;
    search = await searchOracle();
    process.exitCode = run(["search"]);
    if (process.exitCode === 0) {
      const control = spawnSync(
        "python3",
        ["modules/notes/tools/search-controls.py", join(folder, "controls")],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            NOTES_COMPONENT: pinned,
            NOTES_SEARCH_ORACLE: search.path,
            JS55_APP_URL: urls.app,
            JS55_WORKER_URL: urls.worker,
            JS55_BOOTSTRAP_URL: urls.bootstrap
          }
        }
      );
      process.exitCode = control.status ?? 1;
    }
  }
} finally {
  try {
    await search?.cleanup();
    await approval?.cleanup();
    await settings?.cleanup();
    await oracle?.cleanup();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
