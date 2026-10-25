import { describe, expect, it } from "vitest";
import "../../packages/module-registry/src/index.js";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { readReminderSummary } from "../../packages/chat/src/reminders/summary/repository.js";
import {
  boundReminderSummary,
  formatReminderSummarySnapshot,
  readReminderSummarySnapshot,
  reminderSummaryCoverage
} from "../../packages/chat/src/reminders/summary/contract.js";
import {
  reminderSummaryExecute,
  reminderSummaryTool
} from "../../packages/chat/src/reminders/summary/tool.js";
import { REMINDER_SUMMARY_SCOPES } from "../../packages/chat/src/reminders/summary/types.js";
import { reminderFixture, reminderNow, reminderSnapshot } from "../fixtures/reminder-summary.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const row = () => reminderFixture().items[0]!;
const delivered = (over = {}) => ({
  ...row(),
  state: "delivered" as const,
  contextState: "dismissed" as const,
  deliveredAt: "2026-10-24T16:00:05.000Z",
  late: false,
  ...over
});

describe("read-only reminder summary", () => {
  it("accepts a valid snapshot and keeps lifecycle and dismissal apart in the text", () => {
    const snap = reminderSnapshot({ scope: "delivered", items: [delivered()] });
    expect(readReminderSummarySnapshot(snap)?.items[0]?.state).toBe("delivered");
    const text = formatReminderSummarySnapshot(snap);
    expect(text).toContain("Delivered 2026-10-24T16:00:05.000Z (on time)");
    expect(text).toContain("Dismissed from chat context");
    expect(text).toContain("is not cancelling it");
    expect(text).not.toMatch(/Cancelled/);
  });
  it("reports repeats as saved terms and never generates later occurrences", () => {
    const items = [
      { ...row(), repeat: { kind: "weekly" as const } },
      {
        ...row(),
        id: "40000000-0000-4000-8000-000000000002",
        repeat: { kind: "interval" as const, seconds: 1800 }
      }
    ];
    const text = formatReminderSummarySnapshot(reminderSnapshot({ items }));
    expect(text).toContain("Repeats weekly");
    expect(text).toContain("Repeats every 30 minutes");
    expect(text).toContain("later repeats are not generated");
  });
  it("shows destination, deadline and Main chat default", () => {
    const text = formatReminderSummarySnapshot(
      reminderSnapshot({
        items: [{ ...row(), destinationTitle: "Errands", deadlineAt: "2026-10-24T18:00:00.000Z" }]
      })
    );
    expect(text).toContain("Destination Errands");
    expect(text).toContain("Deadline 2026-10-24T18:00:00.000Z");
    expect(formatReminderSummarySnapshot(reminderSnapshot())).toContain("Destination Main chat");
  });
  it("uses actor-local days for the due day", () => {
    const late = reminderSnapshot({
      items: [{ ...row(), dueAt: "2026-10-24T06:59:59.000Z", dueLocalDay: "2026-10-23" }]
    });
    expect(readReminderSummarySnapshot(late)).not.toBeNull();
    const wrong = reminderSnapshot({
      items: [{ ...row(), dueAt: "2026-10-24T06:59:59.000Z", dueLocalDay: "2026-10-24" }]
    });
    expect(readReminderSummarySnapshot(wrong)).toBeNull();
  });
  it("states empty scope without claiming an account total", () => {
    const empty = reminderSnapshot({ scope: "ended", items: [] });
    expect(readReminderSummarySnapshot(empty)).not.toBeNull();
    expect(formatReminderSummarySnapshot(empty)).toContain(
      "0 matching saved reminders in this scope"
    );
  });
  it("labels a lookahead-truncated result as partial", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      ...row(),
      id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    }));
    const snap = reminderSnapshot({ truncated: true, items });
    expect(readReminderSummarySnapshot(snap)).not.toBeNull();
    expect(formatReminderSummarySnapshot(snap)).toContain(
      "Partial: first 12 matching reminders by due time; more exist"
    );
  });
  it("keeps maximum-length text intact while bounding the visual and fallback together", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      ...row(),
      id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      text: "x".repeat(500)
    }));
    const summary = boundReminderSummary(reminderFixture({ items }));
    expect(summary.truncated).toBe(true);
    expect(summary.items.length).toBeLessThan(12);
    expect(summary.items).toEqual(items.slice(0, summary.items.length));
    const service = new VisualPresentationService();
    const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
    const ctx = { ...identity, requestId: "test", chatSessionId: "session" };
    const turn = service.begin("session", identity);
    const registered = service.registerSnapshot(ctx, reminderSnapshot(summary));
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error("registration failed");
    const presented = service.present(ctx, {
      catalogVersion: registered.catalogVersion,
      blocks: [{ kind: registered.templateKind, snapshotRefs: [registered.ref] }],
      interactions: []
    });
    expect(presented.ok).toBe(true);
    if (presented.ok) {
      expect(presented.reply.fallbackText.length).toBeLessThanOrEqual(4000);
      expect(presented.reply.fallbackText).toContain("x".repeat(500));
      expect(readReminderSummarySnapshot(presented.reply.snapshots[0])?.items).toEqual(
        summary.items
      );
    }
    turn.close();
  });
  it("binds references to actor, thread and turn and rejects forged references", () => {
    const service = new VisualPresentationService();
    const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
    const ctx = { ...identity, requestId: "test", chatSessionId: "session" };
    const turn = service.begin("session", identity);
    const registered = service.registerSnapshot(ctx, reminderSnapshot());
    if (!registered.ok) throw new Error("registration failed");
    const proposal = {
      catalogVersion: registered.catalogVersion,
      blocks: [{ kind: registered.templateKind, snapshotRefs: [registered.ref] }],
      interactions: []
    };
    expect(service.present({ ...ctx, threadId: "other" }, proposal).ok).toBe(false);
    expect(service.present(ctx, proposal).ok).toBe(true);
    turn.close();
    const fresh = service.begin("session", { ...identity, turnId: "fresh" });
    expect(
      service.present(
        { ...ctx, turnId: "fresh" },
        { ...proposal, blocks: [{ kind: "reminders.summary", snapshotRefs: ["forged"] }] }
      ).ok
    ).toBe(false);
    fresh.close();
  });
  it.each([
    "source",
    "origin",
    "timeZone",
    "localDate",
    "retrievedAt",
    "coverage",
    "state",
    "contextState",
    "deliveredWithoutTime",
    "pendingWithDelivery",
    "badRepeat",
    "duplicate",
    "extra",
    "scope",
    "emptyPartial"
  ])("rejects forged %s rather than promoting model facts", (field) => {
    const s = reminderSnapshot();
    const v = s.fields;
    const item = v.items[0]!;
    if (field === "source") s.source.id = "foreign";
    if (field === "origin") Object.assign(s, { origin: "user" });
    if (field === "timeZone") v.timeZone = "Unknown/Zone";
    if (field === "localDate") v.localDate = "2026-10-25";
    if (field === "retrievedAt") v.retrievedAt = "bad";
    if (field === "coverage") s.coverage = "whole account";
    if (field === "state") Object.assign(item, { state: "finished" });
    if (field === "contextState") Object.assign(item, { contextState: "gone" });
    if (field === "deliveredWithoutTime") Object.assign(item, { state: "delivered" });
    if (field === "pendingWithDelivery") Object.assign(item, { deliveredAt: reminderNow });
    if (field === "badRepeat") Object.assign(item, { repeat: { kind: "monthly" } });
    if (field === "duplicate") v.items.push({ ...item });
    if (field === "extra") Object.assign(item, { secret: "unknown" });
    if (field === "scope") v.scope = "delivered";
    if (field === "emptyPartial") {
      v.truncated = true;
      v.items = [];
    }
    expect(readReminderSummarySnapshot(s)).toBeNull();
    expect(formatReminderSummarySnapshot(s)).toBe("");
  });
  it("runs only bounded SELECTs with no lock, join or write for every scope", async () => {
    for (const scope of REMINDER_SUMMARY_SCOPES) {
      const { scoped, queries } = makeRecordingDb();
      const summary = await readReminderSummary(scoped, scope, new Date(reminderNow));
      expect(summary.items).toEqual([]);
      expect(queries).toHaveLength(2);
      expect(queries.every((q) => q.sql.startsWith("select "))).toBe(true);
      expect(queries[1]?.sql).not.toMatch(/\b(join|update|insert|delete|for update)\b/i);
      expect(queries[1]?.sql).toContain("app.current_actor_user_id()");
      expect(queries[1]?.parameters.at(-1)).toBe(13);
    }
  });
  it("filters by lifecycle state for the chosen scope", async () => {
    const { scoped, queries } = makeRecordingDb();
    await readReminderSummary(scoped, "ended", new Date(reminderNow));
    expect(queries[1]?.parameters).toEqual(
      expect.arrayContaining(["cancelled", "expired", "failed"])
    );
    const all = makeRecordingDb();
    await readReminderSummary(all.scoped, "all", new Date(reminderNow));
    expect(all.queries[1]?.sql).not.toContain('"state" in');
  });
  it("rejects malformed input and stays useful without a registrar", async () => {
    const { scoped } = makeRecordingDb();
    const ctx = {
      actorUserId: "20000000-0000-4000-8000-000000000001",
      requestId: "summary-test",
      chatSessionId: "test-session"
    };
    await expect(reminderSummaryExecute(scoped, { scope: "private" }, ctx)).rejects.toThrow(
      "Invalid"
    );
    await expect(reminderSummaryExecute(scoped, { extra: 1 }, ctx)).rejects.toThrow("Invalid");
    const read = await reminderSummaryExecute(scoped, {}, ctx);
    expect(read.data).toHaveProperty("summary.items", []);
    expect(read.data).not.toHaveProperty("presentation");
    expect(reminderSummaryTool.risk).toBe("read");
    expect(reminderSummaryTool.description.split(/\s+/).length).toBeLessThan(150);
    expect(reminderSummaryCoverage(reminderFixture())).toContain("Nothing was changed");
  });
});
