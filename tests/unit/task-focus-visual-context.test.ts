import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@moss/db";
import "../../packages/module-registry/src/index.js";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { renderAndCap } from "../../packages/ai/src/gateway/output-validation.js";
import { TaskDriftRepository } from "../../packages/tasks/src/drift.js";
import { TasksRepository } from "../../packages/tasks/src/repository.js";
import { serializeTask } from "../../packages/tasks/src/serialize.js";
import { taskFocusExecute } from "../../packages/tasks/src/tools.js";
import { taskFocusToolOutputSchema } from "../../packages/tasks/src/tool-schemas.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
import { summaryNow } from "../fixtures/task-summary.js";

const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
const ctx = { ...identity, requestId: "focus-test", chatSessionId: "session" };
function task(title: string): Task {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    owner_user_id: "actor",
    list_id: "list",
    parent_task_id: null,
    title,
    description: null,
    status: "todo",
    priority: 4,
    position: 0,
    due_at: null,
    do_at: null,
    completed_at: null,
    effort: null,
    source: "manual",
    source_ref: null,
    external_key: null,
    recurrence: null,
    recurrence_series_id: null,
    suggestion_metadata: null,
    created_at: new Date(summaryNow),
    updated_at: new Date(summaryNow)
  };
}
function focusRows(rows: Task[]) {
  vi.spyOn(TaskDriftRepository.prototype, "getFocus").mockResolvedValue(rows);
  vi.spyOn(TasksRepository.prototype, "getTagsForTasks").mockResolvedValue(new Map());
}
afterEach(() => vi.restoreAllMocks());

describe("Focus supplemental today summary", () => {
  it("preserves the exact legacy result and performs no supplemental read without a registrar", async () => {
    const rows = [task("Ranked first"), task("Ranked second")];
    focusRows(rows);
    const { scoped, queries } = makeRecordingDb();
    expect(await taskFocusExecute(scoped, {}, ctx)).toEqual({
      data: { items: rows.map((row) => serializeTask(row)) },
      columnOrder: ["id", "title", "status", "dueAt", "priority"]
    });
    expect(queries).toEqual([]);
  });

  it.each([0, 1, 100])(
    "keeps the independently sourced proposal through the gateway with %i Focus rows",
    async (count) => {
      const rows = Array.from({ length: count }, () => task("Focus ranking ".repeat(100)));
      focusRows(rows);
      const source = task("Undated independent summary task");
      const { scoped, queries } = makeRecordingDb({ rows: [source] });
      const service = new VisualPresentationService();
      const turn = service.begin("session", identity);
      try {
        const result = await taskFocusExecute(scoped, {}, ctx, { visualPresentation: service });
        expect(result.data.items).toEqual(rows.map((row) => serializeTask(row)));
        const rendered = renderAndCap(taskFocusToolOutputSchema, result);
        const text = String(rendered.text);
        // A real model sees the sanitized/capped output, not the executor's raw object.
        const proposalStart = text.indexOf('"proposal":') + '"proposal":'.length;
        const proposalEnd = text.indexOf("\n    }", proposalStart);
        expect(proposalStart).toBeGreaterThan('"proposal":'.length);
        const proposal = JSON.parse(text.slice(proposalStart, proposalEnd));
        const presented = service.present(ctx, proposal);
        expect(presented.ok).toBe(true);
        if (!presented.ok) throw new Error("Source proposal was lost in the gateway");
        expect(presented.reply.snapshots[0]?.fields.items).toEqual([
          expect.objectContaining({ title: source.title, dueState: "undated" })
        ]);
        expect(presented.reply.fallbackText).not.toContain("Focus ranking");
        expect(text.indexOf('"todayContext"')).toBeLessThan(text.lastIndexOf('"items"'));
        if (count === 100) expect(text).toContain("[truncated tool result]");
        expect(queries.map((q) => q.sql.split(" ")[0])).toEqual([
          "SAVEPOINT",
          "select",
          "select",
          "RELEASE"
        ]);
      } finally {
        turn.close();
      }
    }
  );

  it("rolls back a failed supplemental query and retains Focus items with an explicit gap", async () => {
    const rows = [task("Useful Focus item")];
    focusRows(rows);
    const { scoped, queries } = makeRecordingDb({
      beforeQuery: async (sql) => {
        if (sql.startsWith("select")) throw new Error("private database error");
      }
    });
    const result = await taskFocusExecute(scoped, {}, ctx, {
      visualPresentation: new VisualPresentationService()
    });
    expect(result.data.items).toEqual(rows.map((row) => serializeTask(row)));
    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual(["SAVEPOINT", "ROLLBACK", "RELEASE"]);
    const rendered = String(renderAndCap(taskFocusToolOutputSchema, result).text);
    expect(rendered).toContain("Today summary unavailable");
    expect(rendered).toContain("Useful Focus item");
    expect(rendered).not.toContain("private database error");
  });

  it("keeps the summary readable when no active turn can register its visual", async () => {
    focusRows([]);
    const { scoped } = makeRecordingDb();
    const result = await taskFocusExecute(scoped, {}, ctx, {
      visualPresentation: new VisualPresentationService()
    });
    expect(result.data).toHaveProperty("todayContext.summary.items", []);
    expect(result.data).not.toHaveProperty("todayContext.presentation");
    expect(String(renderAndCap(taskFocusToolOutputSchema, result).text)).toContain(
      "Visual presentation unavailable"
    );
  });
});
