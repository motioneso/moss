import { describe, expect, it } from "vitest";
import "../../packages/module-registry/src/index.js";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { localDayRange } from "@moss/module-sdk";
import { readTaskSummary } from "../../packages/tasks/src/summary/repository.js";
import {
  readTaskSummarySnapshot,
  boundTaskSummary,
  formatTaskSummarySnapshot,
  taskDueState,
  taskSummaryCoverage
} from "../../packages/tasks/src/summary/contract.js";
import { taskSummaryExecute, taskSummaryTool } from "../../packages/tasks/src/summary/tool.js";
import { TASK_SUMMARY_SCOPES } from "../../packages/tasks/src/summary/types.js";
import { summaryFixture, summarySnapshot, summaryNow } from "../fixtures/task-summary.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

describe("read-only Tasks summary", () => {
  it("keeps maximum-length source titles intact while bounding a partial visual and fallback", () => {
    const row = summaryFixture().items[0]!;
    const items = Array.from({ length: 12 }, (_, i) => ({
      ...row,
      id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: "x".repeat(500),
      status: "done" as const,
      dueState: "inactive" as const,
      completedAt: summaryNow,
      recurring: true
    }));
    const summary = boundTaskSummary(summaryFixture({ scope: "completed", items }));
    expect(summary.truncated).toBe(true);
    expect(summary.items.length).toBeGreaterThan(0);
    expect(summary.items.length).toBeLessThan(12);
    expect(summary.items).toEqual(items.slice(0, summary.items.length));
    const service = new VisualPresentationService();
    const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
    const ctx = { ...identity, requestId: "test", chatSessionId: "session" };
    const turn = service.begin("session", identity);
    const registered = service.registerSnapshot(ctx, summarySnapshot(summary));
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error("Bounded source registration failed");
    const presented = service.present(ctx, {
      catalogVersion: registered.catalogVersion,
      blocks: [{ kind: registered.templateKind, snapshotRefs: [registered.ref] }],
      interactions: []
    });
    expect(presented.ok).toBe(true);
    if (presented.ok) {
      expect(presented.reply.fallbackText.length).toBeLessThanOrEqual(4000);
      expect(presented.reply.fallbackText).toContain(
        `Partial: first ${summary.items.length} matching tasks`
      );
      expect(presented.reply.fallbackText).toContain("x".repeat(500));
      expect(readTaskSummarySnapshot(presented.reply.snapshots[0])?.items).toEqual(summary.items);
    }
    turn.close();
  });
  it.each([["done"], { toString: () => "done" }])("rejects non-string task states", (status) => {
    const snapshot = summarySnapshot({ scope: "all" });
    Object.assign(snapshot.fields.items[0]!, { status, dueState: "inactive" });
    expect(readTaskSummarySnapshot(snapshot)).toBeNull();
  });
  it("binds source references to actor, thread and turn, rejects forgery and discards on cancellation", () => {
    const service = new VisualPresentationService();
    const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
    const ctx = { ...identity, requestId: "test", chatSessionId: "session" };
    const turn = service.begin("session", identity);
    const registered = service.registerSnapshot(ctx, summarySnapshot());
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error("Registration failed");
    const proposal = {
      catalogVersion: registered.catalogVersion,
      blocks: [{ kind: registered.templateKind, snapshotRefs: [registered.ref] }],
      interactions: []
    };
    expect(service.present({ ...ctx, threadId: "other" }, proposal).ok).toBe(false);
    const accepted = service.present(ctx, proposal);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.reply.fallbackText).toContain("Draft proposal");
      expect(readTaskSummarySnapshot(accepted.reply.snapshots[0])).not.toBeNull();
    }
    turn.close();
    expect(service.registerSnapshot(ctx, summarySnapshot()).ok).toBe(false);
    const fresh = service.begin("session", { ...identity, turnId: "fresh" });
    expect(
      service.present(
        { ...ctx, turnId: "fresh" },
        { ...proposal, blocks: [{ kind: "tasks.summary", snapshotRefs: ["forged"] }] }
      ).ok
    ).toBe(false);
    fresh.close();
  });
  it("uses actor-local calendar days, retains stored noon and never guesses a deadline", () => {
    expect(
      taskDueState("todo", "2026-10-24T01:00:00.000Z", "2026-10-23", "America/Los_Angeles")
    ).toBe("today");
    expect(
      taskDueState("todo", "2026-10-23T06:59:59.000Z", "2026-10-23", "America/Los_Angeles")
    ).toBe("overdue");
    expect(
      taskDueState("todo", "2026-10-24T07:00:00.000Z", "2026-10-23", "America/Los_Angeles")
    ).toBe("upcoming");
    expect(taskDueState("todo", null, "2026-10-23", "America/Los_Angeles")).toBe("undated");
    for (const status of ["done", "archived", "suggested"] as const)
      expect(taskDueState(status, "2020-01-01T00:00:00.000Z", "2026-10-23", "UTC")).toBe(
        "inactive"
      );
    expect(readTaskSummarySnapshot(summarySnapshot())?.items[0]?.dueAt).toBe(
      "2026-10-23T19:00:00.000Z"
    );
    expect(formatTaskSummarySnapshot(summarySnapshot())).toContain(
      "original date-only intent is not retained"
    );
  });
  it.each([
    ["2026-03-08", 23],
    ["2026-11-01", 25]
  ] as const)("queries actual DST boundaries for %s", async (day, hours) => {
    const { scoped, queries } = makeRecordingDb();
    const now = new Date(`${day}T12:00:00Z`);
    await readTaskSummary(scoped, "overdue", now);
    const range = localDayRange(day, "America/Los_Angeles");
    expect(range.end.getTime() - range.start.getTime()).toBe(hours * 3_600_000);
    expect(queries[1]?.parameters).toContainEqual(range.start);
  });
  it("executes only bounded SELECTs without touching recurrence or owner-only lists", async () => {
    for (const scope of TASK_SUMMARY_SCOPES) {
      const { scoped, queries } = makeRecordingDb();
      const summary = await readTaskSummary(scoped, scope, new Date(summaryNow));
      expect(summary.items).toEqual([]);
      expect(queries).toHaveLength(2);
      expect(queries.every((q) => q.sql.startsWith("select "))).toBe(true);
      expect(queries[1]?.sql).not.toMatch(/\b(join|update|insert|delete)\b/i);
      expect(queries[1]?.parameters.at(-1)).toBe(13);
    }
  });
  it("keeps no-result scope explicit and labels lookahead coverage without invented totals", () => {
    const empty = summarySnapshot({ scope: "completed", items: [] });
    expect(readTaskSummarySnapshot(empty)).not.toBeNull();
    expect(formatTaskSummarySnapshot(empty)).toContain("0 matching persisted tasks in this scope");
    const base = summaryFixture().items[0]!;
    const partial = summarySnapshot({
      truncated: true,
      items: Array.from({ length: 12 }, (_, i) => ({
        ...base,
        id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`
      }))
    });
    expect(readTaskSummarySnapshot(partial)).not.toBeNull();
    expect(formatTaskSummarySnapshot(partial)).toContain(
      "Partial: first 12 matching tasks; more exist"
    );
  });
  it("preserves completion, priority and persisted recurrence without calling it active work", () => {
    const row = {
      ...summaryFixture().items[0]!,
      status: "done" as const,
      dueState: "inactive" as const,
      recurring: true,
      completedAt: summaryNow
    };
    const snapshot = summarySnapshot({ scope: "completed", items: [row] });
    expect(readTaskSummarySnapshot(snapshot)?.items[0]).toEqual(row);
    const fallback = formatTaskSummarySnapshot(snapshot);
    expect(fallback).toContain("Completed at");
    expect(fallback).toContain("Priority 4/5");
    expect(fallback).toContain("future occurrences are not generated");
  });
  it.each([
    "source",
    "origin",
    "timeZone",
    "localDate",
    "retrievedAt",
    "coverage",
    "dueState",
    "status",
    "priority",
    "duplicate",
    "extra",
    "scope",
    "emptyPartial"
  ])("rejects forged %s rather than promoting model facts", (field) => {
    const s = summarySnapshot();
    const v = s.fields;
    if (field === "source") s.source.id = "foreign";
    if (field === "origin") Object.assign(s, { origin: "user" });
    if (field === "timeZone") v.timeZone = "Unknown/Zone";
    if (field === "localDate") v.localDate = "2026-10-24";
    if (field === "retrievedAt") v.retrievedAt = "bad";
    if (field === "coverage") s.coverage = "whole account";
    if (field === "dueState") v.items[0]!.dueState = "overdue";
    if (field === "status") Object.assign(v.items[0]!, { status: "finished" });
    if (field === "priority") v.items[0]!.priority = 10;
    if (field === "duplicate") v.items.push({ ...v.items[0]! });
    if (field === "extra") Object.assign(v.items[0]!, { secret: "unknown" });
    if (field === "scope") v.scope = "upcoming";
    if (field === "emptyPartial") {
      v.truncated = true;
      v.items = [];
    }
    expect(readTaskSummarySnapshot(s)).toBeNull();
    expect(formatTaskSummarySnapshot(s)).toBe("");
  });
  it("rejects malformed input and leaves valid non-chat reads useful without a registrar", async () => {
    const { scoped } = makeRecordingDb();
    const ctx = {
      actorUserId: "20000000-0000-4000-8000-000000000001",
      requestId: "summary-test",
      chatSessionId: "test-session"
    };
    await expect(taskSummaryExecute(scoped, { scope: "private" }, ctx)).rejects.toThrow("Invalid");
    const read = await taskSummaryExecute(scoped, {}, ctx);
    expect(read.data).toHaveProperty("summary.items", []);
    expect(read.data).not.toHaveProperty("presentation");
    expect(taskSummaryTool.risk).toBe("read");
    expect(taskSummaryCoverage(summaryFixture())).toContain("Reminders are not included");
  });
});
