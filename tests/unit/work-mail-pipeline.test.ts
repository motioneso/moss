import { afterEach, describe, expect, it, vi } from "vitest";
import { DataContextRunner } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import { ingestWorkMail } from "../../packages/connectors/src/work-mail/pipeline.js";
import type {
  CapturedMailMessage,
  WorkMailPorts
} from "../../packages/connectors/src/work-mail/types.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const access = { actorUserId: "00000000-0000-4000-8000-000000000001" };
const messages: CapturedMailMessage[] = Array.from({ length: 6 }, (_, index) => ({
  sender: "invented@example.test",
  subject: `Invented ${index + 1}`,
  receivedAt: `2026-10-26T10:0${index}:00Z`,
  threadHint: null,
  body: "Please review the invented proposal.",
  bodyTruncated: false
}));
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const recording = makeRecordingDb();
  const context = new DataContextRunner(recording.scoped.db);
  vi.spyOn(context, "withDataContext").mockImplementation(async (_access, work) =>
    work(recording.scoped)
  );
  let saved: unknown = null;
  vi.spyOn(PreferencesRepository.prototype, "get").mockImplementation(async () => saved);
  vi.spyOn(PreferencesRepository.prototype, "upsert").mockImplementation(
    async (_db, _key, value) => {
      saved = value;
    }
  );
  const judge = vi
    .fn<WorkMailPorts["judge"]>()
    .mockResolvedValue({ decision: "nothing", reason: "Plain mail" });
  const append = vi.fn<WorkMailPorts["notes"]["append"]>().mockResolvedValue("written");
  const ports: WorkMailPorts = {
    preferences: { list: async () => ["Never write anything about HR mail"] },
    people: { senderContext: async () => "Invented teammate" },
    notes: { candidates: async () => [], append },
    judge,
    now: () => new Date("2026-10-26T11:00:00Z")
  };
  return { context, ports, judge, append };
}
describe("shared mail pipeline", () => {
  it("sorts oldest first, stops at AI failure and retains the last successful marker", async () => {
    const { context, ports, judge } = fixture();
    judge.mockImplementation(async (_db, input) => {
      if (input.message.subject === "Invented 4") throw new Error("upstream private content");
      return { decision: "nothing", reason: "Plain mail" };
    });
    const result = await ingestWorkMail(context, access, [...messages].reverse(), ports);
    expect(result.processed).toBe(3);
    expect(result.stoppedAt).toBe(3);
    expect(result.cursor.marker?.receivedAt).toBe(new Date(messages[2]!.receivedAt).toISOString());
    expect(judge).toHaveBeenCalledTimes(4);
    expect(judge.mock.calls[0]?.[1].preferences).toContain("Never write anything about HR mail");
    expect(JSON.stringify(result)).not.toContain("upstream");
  });
  it("does not judge duplicate mail and caps a run at 25", async () => {
    const { context, ports, judge } = fixture();
    await ingestWorkMail(context, access, messages, ports);
    expect((await ingestWorkMail(context, access, messages, ports)).processed).toBe(0);
    expect(judge).toHaveBeenCalledTimes(6);
    judge.mockClear();
    await ingestWorkMail(
      context,
      access,
      Array.from({ length: 30 }, (_, index) => ({
        ...messages[0]!,
        subject: `New ${index}`,
        receivedAt: "2026-10-27T10:00:00Z"
      })),
      ports
    );
    expect(judge).toHaveBeenCalledTimes(25);
  });
  it("retries a changed note once and never advances on unavailable notes or invalid output", async () => {
    const { context, ports, judge, append } = fixture();
    judge.mockResolvedValue({
      decision: "note",
      target: { kind: "default" },
      entry: "Review the proposal.",
      reason: "Action requested"
    });
    append.mockResolvedValue("changed");
    expect((await ingestWorkMail(context, access, messages, ports)).processed).toBe(0);
    expect(append).toHaveBeenCalledTimes(2);
    append.mockClear();
    judge.mockResolvedValue({
      decision: "note",
      target: { kind: "candidate", index: 42 },
      entry: "Bad destination",
      reason: "Invalid"
    });
    expect((await ingestWorkMail(context, access, messages, ports)).processed).toBe(0);
    expect(append).not.toHaveBeenCalled();
  });
  it("does not advance if aborted", async () => {
    const { context, ports, judge } = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      (await ingestWorkMail(context, access, messages, ports, controller.signal)).processed
    ).toBe(0);
    expect(judge).not.toHaveBeenCalled();
  });
});
