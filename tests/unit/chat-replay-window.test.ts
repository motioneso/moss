import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REPLAY_MESSAGES,
  REPLAY_TOKEN_CAP,
  SUMMARY_TOKEN_CAP
} from "../../packages/chat/src/live/replay-window.js";
import { getReplayK } from "../../packages/chat/src/live/persistence.js";

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

describe("exported constants", () => {
  it("match the replay budget defaults", () => {
    expect(DEFAULT_REPLAY_MESSAGES).toBe(40);
    expect(REPLAY_TOKEN_CAP).toBe(8000);
    expect(SUMMARY_TOKEN_CAP).toBe(1000);
  });
});
