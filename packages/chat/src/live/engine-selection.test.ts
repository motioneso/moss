import { describe, expect, it } from "vitest";
import type { TmuxIo } from "@moss/ai";
import { isBoundedFallbackEngine, createChatEngine } from "./engine-selection.js";
import { ClaudePrintChatEngine } from "./claude-print-chat-engine.js";

function fakeIo(): TmuxIo {
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile() {
      throw new Error("not used");
    },
    async writeFile() {},
    async sleep() {}
  };
}

describe("isBoundedFallbackEngine", () => {
  it("anthropic + non_interactive is bounded-fallback", () => {
    expect(isBoundedFallbackEngine("anthropic", "non_interactive")).toBe(true);
  });
});

describe("createChatEngine", () => {
  it("selects ClaudePrintChatEngine when persistentRuntimeEnabled is explicitly false", () => {
    const engine = createChatEngine("anthropic", "session-1", fakeIo(), {
      executionMode: "non_interactive",
      persistentRuntimeEnabled: false
    });
    expect(engine).toBeInstanceOf(ClaudePrintChatEngine);
  });
});
