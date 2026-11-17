/** Execute the legacy tools on fixture rows in the disposable database. */
import assert from "node:assert/strict";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import type { ToolExecute } from "@moss/module-sdk";
import {
  goalListExecute,
  goalGetExecute,
  goalCreateExecute,
  goalUpdateExecute,
  goalAddEvidenceExecute
} from "../../../packages/goals/src/tools.js";

const tools: Readonly<Record<string, ToolExecute>> = {
  "goals.list": goalListExecute,
  "goals.get": goalGetExecute,
  "goals.create": goalCreateExecute,
  "goals.update": goalUpdateExecute,
  "goals.addEvidence": goalAddEvidenceExecute
};
assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const {
  actor,
  tool,
  parameters
}: {
  actor: string;
  tool: string;
  parameters: Record<string, unknown>;
} = JSON.parse(input);
const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
try {
  const execute = tools[tool];
  assert.ok(execute, "Unknown legacy tool");
  const result = await new DataContextRunner(db).withDataContext(
    { actorUserId: actor, requestId: "goals-tools-parity" },
    (scoped) =>
      execute(scoped, parameters, {
        actorUserId: actor,
        requestId: "goals-tools-parity",
        chatSessionId: "goals-fixture"
      })
  );
  console.log(JSON.stringify(result));
} finally {
  await db.destroy();
}
