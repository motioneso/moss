import { describe, expect, it } from "vitest";

import {
  defaultCliAgentIdForProviderKind,
  isAcpAgentCompatibleWithProviderKind
} from "./provider-identity.js";

describe("ACP provider identity", () => {
  it("maps legacy OpenAI-compatible CLI configs to Codex", () => {
    expect(defaultCliAgentIdForProviderKind("openai-compatible")).toBe("codex-acp");
    expect(isAcpAgentCompatibleWithProviderKind("openai-compatible", "codex-acp")).toBe(true);
  });

  it("allows OpenCode only as an explicit OpenAI-compatible ACP agent", () => {
    expect(isAcpAgentCompatibleWithProviderKind("openai-compatible", "opencode")).toBe(true);
    expect(isAcpAgentCompatibleWithProviderKind("anthropic", "opencode")).toBe(false);
    expect(isAcpAgentCompatibleWithProviderKind("openai-compatible", "unknown-agent")).toBe(false);
  });

  it("does not assign API protocol kinds an implicit CLI agent", () => {
    expect(defaultCliAgentIdForProviderKind("custom")).toBeUndefined();
    expect(defaultCliAgentIdForProviderKind("ollama")).toBeUndefined();
  });
});
