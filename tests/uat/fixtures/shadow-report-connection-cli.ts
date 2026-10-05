import { createAppRuntimeRunner, createMigrationOwnerDb } from "../seed/connections.js";
import { assertTargetIsEphemeral } from "../seed/guard.js";
import {
  requireShadowReportProject,
  seedShadowReportConnection
} from "./shadow-report-connection.js";

// This entrypoint runs only inside the already-provisioned, disposable UAT stack. Retain
// both existing seed guards: the environment/URL fence and inspection of actual users.
if (process.env.JARVIS_UAT_SEED_CONFIRM !== "1")
  throw new Error("Shadow report fixture requires the isolated UAT seed environment");
const project = requireShadowReportProject(process.argv[2]);
const migrationDb = createMigrationOwnerDb();
try {
  await assertTargetIsEphemeral(migrationDb);
} finally {
  await migrationDb.destroy();
}
const runner = createAppRuntimeRunner();
try {
  await seedShadowReportConnection(runner, project);
  console.log("[shadow-report-fixture] seeded one synthetic classifier light tool");
} finally {
  await runner.destroy();
}
