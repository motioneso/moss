import { expect, it } from "vitest";
import type { TranscriptRecord } from "@moss/shared";
import { mergeFallbacks } from "../../apps/web/src/chat/use-chat-stream.js";

const user2: TranscriptRecord = { kind: "user", text: "Second question", messageId: "u2" };
const reply2: TranscriptRecord = { kind: "reply", text: "Same answer", messageId: "r2" };
const user3: TranscriptRecord = { kind: "user", text: "Third question", messageId: "u3" };
const reply3: TranscriptRecord = { kind: "reply", text: "Same answer", messageId: "r3" };
const activity2: TranscriptRecord = { kind: "thought", text: "Working on second question" };
const activity3: TranscriptRecord = { kind: "thought", text: "Working on third question" };

it("keeps a missed saved reply before the next turn without moving live activity", () => {
  expect(
    mergeFallbacks([user2, reply2, user3, reply3], [user2, activity2, user3, activity3, reply3])
  ).toEqual([user2, activity2, reply2, user3, activity3, reply3]);
});

it("keeps the completed fallback before a newer turn whose HTTP response is pending", () => {
  expect(mergeFallbacks([user2, reply2], [user2, activity2, user3, activity3])).toEqual([
    user2,
    activity2,
    reply2,
    user3,
    activity3
  ]);
});

it("uses stored identities when separate turns have identical answer text", () => {
  expect(mergeFallbacks([user2, reply2, user3, reply3], [user2, reply2, user3])).toEqual([
    user2,
    reply2,
    user3,
    reply3
  ]);
});

it("deduplicates only one occurrence of an uncorrelated stream message", () => {
  const reply: TranscriptRecord = { kind: "reply", text: "Answer" };
  expect(mergeFallbacks([reply, reply], [reply])).toEqual([reply, reply]);
});
