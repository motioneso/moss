/** Execute the legacy Wellness tools on fixture rows in the disposable database. */
import assert from "node:assert/strict";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import type { ToolExecute } from "@moss/module-sdk";
import {
  wellnessMedicationAdherenceExecute,
  wellnessRecentCheckInsExecute
} from "../../../packages/wellness/src/tools.js";

const tools: Readonly<Record<string, ToolExecute>> = {
  "wellness.recentCheckIns": wellnessRecentCheckInsExecute,
  "wellness.medicationAdherence": wellnessMedicationAdherenceExecute
};
assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const {
  actor,
  tool,
  parameters,
  consent
}: {
  actor: string;
  tool: string;
  parameters: Record<string, unknown>;
  consent?: boolean;
} = JSON.parse(input);
const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
try {
  const execute = tools[tool];
  assert.ok(execute, "Unknown legacy tool");
  // With no saved choice the old code falls back to the chat's wellness-active flag.
  const services = { wellnessActive: consent ?? true } as never;
  const result = await new DataContextRunner(db).withDataContext(
    { actorUserId: actor, requestId: "wellness-tools-parity" },
    (scoped) =>
      execute(
        scoped,
        parameters,
        {
          actorUserId: actor,
          requestId: "wellness-tools-parity",
          chatSessionId: "wellness-fixture",
          localTimezone: "UTC"
        } as never,
        services
      )
  );
  console.log(JSON.stringify(result));
} finally {
  await db.destroy();
}
