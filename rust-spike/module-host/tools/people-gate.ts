import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";
import { peopleOracle } from "./people-oracle.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
if (!process.env.JS50_PEOPLE_COMPONENT)
  throw new Error("Build People component and set JS50_PEOPLE_COMPONENT");
// Pin one artifact for the whole run; a concurrent build must not replace the
// bytes between the printed digest and the separate Rust test processes.
const component = await readFile(process.env.JS50_PEOPLE_COMPONENT);
console.log(
  "Compiled People component sha256:",
  createHash("sha256").update(component).digest("hex")
);
const suites = [
  "people_privacy",
  "people_persistence",
  "people_guest_database",
  "people_tools_database",
  "people_notes_database",
  "linked_notes_database",
  "people_guest"
];
const selected = process.env.JS50_PEOPLE_SUITE;
if (selected && !suites.includes(selected)) throw new Error("Unknown People test suite");
const componentFolder = await mkdtemp(join(tmpdir(), "moss-people-component-"));
const componentPath = join(componentFolder, "people.wasm");
let oracle: Awaited<ReturnType<typeof peopleOracle>> | undefined;
const urls = getMossDatabaseUrls();
try {
  await writeFile(componentPath, component, { mode: 0o400 });
  oracle = await peopleOracle();
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "rust-spike/module-host/Cargo.toml",
      ...(selected ? [selected] : suites).flatMap((suite) => ["--test", suite]),
      "--",
      "--ignored",
      "--nocapture",
      "--test-threads=1"
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        JS43_APP_URL: urls.app,
        JS43_WORKER_URL: urls.worker,
        JS43_BOOTSTRAP_URL: urls.bootstrap,
        JS47_APP_URL: urls.app,
        JS47_WORKER_URL: urls.worker,
        JS47_BOOTSTRAP_URL: urls.bootstrap,
        JS50_PEOPLE_COMPONENT: componentPath,
        JS50_PEOPLE_ORACLE: oracle.path
      }
    }
  );
  process.exitCode = run.status ?? 1;
} finally {
  try {
    await oracle?.cleanup();
  } finally {
    await rm(componentFolder, { recursive: true, force: true });
  }
}
