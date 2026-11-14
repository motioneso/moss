import { spawnSync } from "node:child_process";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
// Weather has no tables, so the package gate needs no database.
const checks = spawnSync("modules/weather/tools/check.sh", { stdio: "inherit", env: process.env });
process.exit(checks.status ?? 1);
