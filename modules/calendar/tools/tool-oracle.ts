/** Production TypeScript tools on the disposable database; draft probes always roll back. */
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { readActorLocale } from "@moss/settings";
import { calendarHeartbeatWindowExecute } from "../../../packages/calendar/src/heartbeat.js";
import { createDayPlanDraftExecute } from "../../../packages/calendar/src/day-plan-chat-tool.js";
import { DayPlanRepository } from "../../../packages/calendar/src/day-plan-repository.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);
const input: {
  actor: string;
  tool: string;
  parameters: Record<string, unknown>;
  tasks?: string[];
} = JSON.parse(stdin);
const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
const contexts = new DataContextRunner(db);
class Rollback extends Error {
  constructor(readonly value: unknown) {
    super("Disposable oracle rollback");
  }
}
try {
  await contexts.withDataContext(
    { actorUserId: input.actor, requestId: "calendar-tool-parity" },
    async (scope) => {
      const locale = await readActorLocale(scope);
      const ctx = {
        actorUserId: input.actor,
        requestId: "calendar-tool-parity",
        chatSessionId: "",
        localTimezone: locale.timezone
      };
      if (input.tool === "calendar.heartbeatWindow") {
        throw new Rollback({
          ok: await calendarHeartbeatWindowExecute(scope, input.parameters, ctx)
        });
      }
      if (input.tool !== "calendar.dayPlanDraft") throw new Error("Unsupported oracle tool");
      // An explicit stand-in for the public Tasks lookup, shared with the Rust fixture.
      const repository = new DayPlanRepository({
        findTask: async (_scope, id) =>
          input.tasks?.includes(id) ? { id, ownerUserId: input.actor } : undefined
      });
      const id = String(input.parameters.planId ?? "").trim();
      const before = await repository.getById(scope, id);
      const value = await createDayPlanDraftExecute(repository)(scope, input.parameters, ctx);
      const plan = await repository.getById(scope, id);
      const original = new Set(before?.blocks.map((block) => block.id));
      let index = 0;
      for (const block of plan?.blocks ?? []) {
        if (!original.has(block.id)) Object.assign(block, { id: `$new-${index++}` });
      }
      throw new Rollback({ ok: value, plan });
    }
  );
} catch (error) {
  console.log(
    JSON.stringify(
      error instanceof Rollback
        ? error.value
        : { error: error instanceof Error ? error.message : "Unknown tool error" }
    )
  );
} finally {
  await db.destroy();
}
