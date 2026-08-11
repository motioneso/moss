import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capSummary,
  DEFAULT_REPLAY_MESSAGES,
  REPLAY_TOKEN_CAP,
  SUMMARY_TOKEN_CAP,
  selectReplayWindow,
  type ReplayMessage
} from "../../packages/chat/src/live/replay-window.js";
import { getReplayK } from "../../packages/chat/src/live/persistence.js";
import { estimateTokens } from "../../packages/chat/src/live/recall-seed.js";

/**
 * Build a message whose formatted `${role}: ${content}` string is exactly
 * `tokens` tokens (estimateTokens = ceil(length / 4)), tagged with `#id#` so
 * assertions can identify which original message survived windowing.
 */
function makeMessage(role: "user" | "assistant", id: number, tokens: number): ReplayMessage {
  const prefixLen = role.length + 2; // "role: "
  const marker = `#${id}#`;
  const targetLen = tokens * 4;
  const fillerLen = targetLen - prefixLen - marker.length;
  if (fillerLen < 0) {
    throw new Error(`tokens too small for id ${id}`);
  }
  return { role, content: `${marker}${"x".repeat(fillerLen)}` };
}

function idOf(message: ReplayMessage): number {
  const match = /#(\d+)#/.exec(message.content);
  if (!match) throw new Error(`no id marker in content: ${message.content}`);
  return Number(match[1]);
}

describe("selectReplayWindow", () => {
  it("T1-a: 50 messages x ~300 tokens -> newest 26 (count-then-token-trim), chronological", () => {
    const messages: ReplayMessage[] = [];
    for (let id = 1; id <= 50; id++) {
      messages.push(makeMessage(id % 2 === 1 ? "user" : "assistant", id, 300));
    }

    const window = selectReplayWindow(messages, { maxMessages: 40, maxTokens: 8000 });

    expect(window).toHaveLength(26);
    expect(window.map(idOf)).toEqual(
      Array.from({ length: 26 }, (_, i) => 25 + i) // ids 25..50
    );
  });

  it("T1-b: 60 x 10-token messages, all under budget -> still capped to newest 40 by count", () => {
    const messages: ReplayMessage[] = [];
    for (let id = 1; id <= 60; id++) {
      messages.push(makeMessage(id % 2 === 1 ? "user" : "assistant", id, 10));
    }

    const window = selectReplayWindow(messages, { maxMessages: 40, maxTokens: 8000 });

    expect(window).toHaveLength(40);
    expect(window.map(idOf)).toEqual(Array.from({ length: 40 }, (_, i) => 21 + i)); // ids 21..60
  });

  it("T1-c: single oversized newest message -> head-truncated, tail preserved", () => {
    const filler = "x".repeat(50_000);
    const content = `HEAD_MARKER_UNIQUE${filler}TAIL_MARKER_UNIQUE`;
    const messages: ReplayMessage[] = [{ role: "user", content }];

    // Sanity: this single message is well beyond the token cap before trimming.
    expect(estimateTokens(`user: ${content}`)).toBeGreaterThan(8000);

    const window = selectReplayWindow(messages, { maxMessages: 40, maxTokens: 8000 });

    expect(window).toHaveLength(1);
    expect(window[0]!.content).not.toContain("HEAD_MARKER_UNIQUE");
    expect(window[0]!.content).toContain("TAIL_MARKER_UNIQUE");
    expect(estimateTokens(`${window[0]!.role}: ${window[0]!.content}`)).toBeLessThanOrEqual(8000);
  });

  it("T1-d: unpaired newest user turn (no trailing assistant reply) is included as-is", () => {
    const messages: ReplayMessage[] = [
      { role: "assistant", content: "reply one" },
      { role: "user", content: "question one" },
      { role: "assistant", content: "reply two" },
      { role: "user", content: "question two, awaiting reply" }
    ];

    const window = selectReplayWindow(messages, { maxMessages: 40, maxTokens: 8000 });

    expect(window).toEqual(messages);
    expect(window[window.length - 1]).toEqual({
      role: "user",
      content: "question two, awaiting reply"
    });
  });
});

describe("getReplayK", () => {
  const ORIG = process.env.JARVIS_CHAT_REPLAY_K;

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env.JARVIS_CHAT_REPLAY_K;
    } else {
      process.env.JARVIS_CHAT_REPLAY_K = ORIG;
    }
    vi.restoreAllMocks();
  });

  it("T1-e: unset env -> default 40", () => {
    delete process.env.JARVIS_CHAT_REPLAY_K;
    expect(getReplayK()).toBe(DEFAULT_REPLAY_MESSAGES);
  });

  it("T1-e: empty string env -> default 40", () => {
    process.env.JARVIS_CHAT_REPLAY_K = "";
    expect(getReplayK()).toBe(DEFAULT_REPLAY_MESSAGES);
  });

  it('T1-e: explicit "0" -> 0 (valid opt-out, no replay)', () => {
    process.env.JARVIS_CHAT_REPLAY_K = "0";
    expect(getReplayK()).toBe(0);
  });

  it("T1-e: non-numeric value -> 40 plus one console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JARVIS_CHAT_REPLAY_K = "not-a-number";
    expect(getReplayK()).toBe(DEFAULT_REPLAY_MESSAGES);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("T1-e: negative value -> 40 plus one console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JARVIS_CHAT_REPLAY_K = "-5";
    expect(getReplayK()).toBe(DEFAULT_REPLAY_MESSAGES);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("capSummary", () => {
  it("T1-f: long summary is tail-truncated to SUMMARY_TOKEN_CAP, head preserved", () => {
    // ~2000 tokens (8000 chars) of raw summary text.
    const filler = "y".repeat(8000 - "HEAD_MARKER_UNIQUE".length - "TAIL_MARKER_UNIQUE".length);
    const summary = `HEAD_MARKER_UNIQUE${filler}TAIL_MARKER_UNIQUE`;
    expect(estimateTokens(summary)).toBeGreaterThan(SUMMARY_TOKEN_CAP);

    const capped = capSummary(summary, SUMMARY_TOKEN_CAP);

    expect(capped.startsWith("HEAD_MARKER_UNIQUE")).toBe(true);
    expect(capped).not.toContain("TAIL_MARKER_UNIQUE");
    expect(estimateTokens(capped)).toBeLessThanOrEqual(SUMMARY_TOKEN_CAP);
  });
});

describe("exported constants", () => {
  it("match the plan's D1 contract", () => {
    expect(DEFAULT_REPLAY_MESSAGES).toBe(40);
    expect(REPLAY_TOKEN_CAP).toBe(8000);
    expect(SUMMARY_TOKEN_CAP).toBe(1000);
  });
});
