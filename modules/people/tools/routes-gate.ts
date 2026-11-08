import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";
import { routesOracle } from "./routes-oracle.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
if (!process.env.JS50_PEOPLE_COMPONENT) throw new Error("Build and set JS50_PEOPLE_COMPONENT");
const component = await readFile(process.env.JS50_PEOPLE_COMPONENT);
console.log("People route component sha256:", createHash("sha256").update(component).digest("hex"));
const folder = await mkdtemp(join(tmpdir(), "moss-people-routes-"));
let oracle: Awaited<ReturnType<typeof routesOracle>> | undefined;
try {
  oracle = await routesOracle();
  const componentPath = join(folder, "people.wasm");
  const oraclePath = join(folder, "oracle.json");
  await writeFile(componentPath, component, { mode: 0o400 });
  await writeFile(oraclePath, JSON.stringify(oracle.value), { mode: 0o600 });
  const urls = getMossDatabaseUrls();
  const result = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "rust-spike/module-host/Cargo.toml",
      "--test",
      "people_routes_database",
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
        JS43_BOOTSTRAP_URL: urls.bootstrap,
        JS50_PEOPLE_COMPONENT: componentPath,
        JS58_PEOPLE_ORACLE: oraclePath
      }
    }
  );
  process.exitCode = result.status ?? 1;
} finally {
  try {
    await oracle?.cleanup();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
