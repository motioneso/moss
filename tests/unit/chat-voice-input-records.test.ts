import { describe, expect, it } from "vitest";
import type { ChatVoiceRequestStatus, TranscriptRecord } from "@moss/shared";
import { mergeVoiceInputRecords } from "../../apps/web/src/chat/voice-input-records.js";

function receipt(
  id: string,
  state: ChatVoiceRequestStatus["state"] = "queued"
): ChatVoiceRequestStatus {
  return {
    id,
    turnId: id,
    threadId: "main",
    sourceDeviceId: "ring",
    recordingId: id,
    transcript: "Identical text",
    createdAt: "2026-10-24T10:00:00.000Z",
    capturedAt: null,
    state,
    userMessageId: null,
    assistantMessageId: null,
    statusMessage: "Waiting"
  };
}
describe("normal voice input reconciliation", () => {
  it("orders arrivals stably and preserves identical text from distinct turns", () => {
    const result = mergeVoiceInputRecords([], [receipt("b"), receipt("a")], new Map());
    expect(result.map((record) => record.turnId)).toEqual(["a", "b"]);
  });
  it.each(["2026-10-24T09:00:00.000Z", "2026-10-24T10:00:00.000Z"])(
    "places an older pending page before a newer live turn, preserving its activity (%s)",
    (createdAt) => {
      const live: TranscriptRecord[] = [
        { kind: "user", text: "Identical text", turnId: "b" },
        { kind: "tool", text: "Current lookup", turnId: "b" },
        { kind: "reply", text: "Current response", turnId: "b" }
      ];
      const older = { ...receipt("a", "ready-to-send"), createdAt };
      const result = mergeVoiceInputRecords(live, [receipt("b", "dispatching"), older], new Map());
      expect(result).toEqual([{ kind: "user", text: older.transcript, turnId: "a" }, ...live]);
    }
  );
  it("replaces live rows by saved identity while retaining tool and unrelated activity", () => {
    const live: TranscriptRecord[] = [
      { kind: "user", text: "Identical text", turnId: "a" },
      { kind: "tool", text: "Calendar lookup", turnId: "a" },
      { kind: "reply", text: "Streaming", turnId: "a" },
      { kind: "user", text: "Next typed input", turnId: "typed" },
      { kind: "thinking", text: "Still working", turnId: "typed" }
    ];
    const saved: TranscriptRecord[] = [
      { kind: "user", text: "Identical text", turnId: "a", messageId: "u" },
      { kind: "reply", text: "Saved reply", turnId: "a", messageId: "r" }
    ];
    const recovered = new Map([["a", saved]]);
    const result = mergeVoiceInputRecords(live, [receipt("a", "replied")], recovered);
    expect(result).toEqual([saved[0], live[1], saved[1], live[3], live[4]]);
    expect(mergeVoiceInputRecords(result, [receipt("a", "replied")], recovered)).toEqual(result);
  });
  it("recovers missed completed turns and inserts a missed reply before the next user", () => {
    const saved: TranscriptRecord[] = [
      { kind: "user", text: "Identical text", turnId: "a", messageId: "u" },
      { kind: "reply", text: "Recovered reply", turnId: "a", messageId: "r" }
    ];
    const requests = [receipt("a", "replied")];
    const recovered = new Map([["a", saved]]);
    expect(mergeVoiceInputRecords([], requests, recovered)).toEqual(saved);
    const typed: TranscriptRecord = { kind: "user", text: "Unsent in-flight", turnId: "typed" };
    expect(mergeVoiceInputRecords([saved[0]!, typed], requests, recovered)).toEqual([
      ...saved,
      typed
    ]);
  });
  it("places an entirely missed saved voice turn before its following typed history", () => {
    const saved: TranscriptRecord[] = [
      { kind: "user", text: "Identical text", turnId: "a", messageId: "u" },
      { kind: "reply", text: "Saved reply", turnId: "a", messageId: "r" }
    ];
    const typed: TranscriptRecord = {
      kind: "user",
      text: "Later typed message",
      turnId: "typed",
      messageId: "typed-message"
    };
    expect(
      mergeVoiceInputRecords([typed], [receipt("a", "replied")], new Map([["a", saved]]), [
        ...saved,
        typed
      ])
    ).toEqual([...saved, typed]);
  });
  it("does not create a user turn for no speech or duplicate a live dispatch user", () => {
    const noSpeech = {
      ...receipt("empty", "no-speech"),
      transcript: "",
      statusMessage: "No speech detected."
    };
    const live: TranscriptRecord = { kind: "user", text: "Identical text", turnId: "a" };
    const result = mergeVoiceInputRecords(
      [live],
      [receipt("a", "dispatching"), noSpeech],
      new Map()
    );
    expect(result.filter((r) => r.kind === "user")).toEqual([live]);
    expect(result.at(-1)).toMatchObject({ kind: "status", text: "No speech detected." });
  });
  it("places a pending receipt before a newer saved typed message", () => {
    const typed: TranscriptRecord = {
      kind: "user",
      text: "Typed later",
      turnId: "typed",
      messageId: "typed-message",
      createdAt: "2026-10-24T10:05:00.000Z"
    };
    const result = mergeVoiceInputRecords([typed], [receipt("a", "interrupted")], new Map());
    expect(result.map((record) => record.turnId)).toEqual(["a", "typed"]);
  });
  it("appends a pending receipt after older saved messages", () => {
    const older: TranscriptRecord = {
      kind: "user",
      text: "Typed earlier",
      turnId: "typed",
      messageId: "typed-message",
      createdAt: "2026-10-24T09:00:00.000Z"
    };
    const result = mergeVoiceInputRecords([older], [receipt("a", "interrupted")], new Map());
    expect(result.map((record) => record.turnId)).toEqual(["typed", "a"]);
  });
  it.each([".", "…", " ? "])("never makes a bubble from punctuation-only text %j", (transcript) => {
    const result = mergeVoiceInputRecords(
      [],
      [{ ...receipt("dot", "interrupted"), transcript, statusMessage: "Interrupted." }],
      new Map()
    );
    expect(result.filter((r) => r.kind === "user")).toEqual([]);
    expect(result).toEqual([{ kind: "status", text: "Interrupted.", turnId: "dot" }]);
  });
});
