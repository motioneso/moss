/** Actual old tool handlers and repository on the disposable database. */
import assert from "node:assert/strict";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import {
  scratchpadReadExecute,
  scratchpadAppendExecute
} from "../../../packages/scratchpad/src/tools.js";

assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += String(chunk);
const { actor, steps } = JSON.parse(input) as {
  actor: string;
  steps: { tool: string; parameters: Record<string, unknown> }[];
};
const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
try {
  const context = new DataContextRunner(db);
  const responses = [];
  for (const step of steps) {
    responses.push(
      await context.withDataContext(
        { actorUserId: actor, requestId: "scratchpad-tool-parity" },
        (scoped) =>
          (step.tool === "scratchpad.read" ? scratchpadReadExecute : scratchpadAppendExecute)(
            scoped,
            step.parameters,
            {
              actorUserId: actor,
              requestId: "scratchpad-tool-parity",
              chatSessionId: "scratchpad-parity"
            }
          )
      )
    );
  }
  console.log(JSON.stringify(responses));
} finally {
  await db.destroy();
}
