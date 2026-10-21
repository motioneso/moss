import { describe, expect, it } from "vitest";

import type { ApiKeyChatReadinessStatus } from "@moss/shared";

import {
  describeChatReadiness,
  showsChatReadiness
} from "../../apps/web/src/settings/settings-ai-chat-readiness.js";

describe("chat readiness text", () => {
  it.each<[ApiKeyChatReadinessStatus, string | null]>([
    ["ready", null],
    ["rejected_key", "The provider rejected the API key"],
    ["unreachable", "Could not reach the provider"],
    ["needs_key", "No API key is saved"],
    ["agent_missing", "The chat program for this provider is not installed"],
    ["runner_unavailable", "The sign-in helper is not running"]
  ])("describes %s", (status, text) => {
    expect(describeChatReadiness(status)).toBe(text);
  });

  it("applies only to Anthropic and OpenAI-compatible API-key rows", () => {
    expect(showsChatReadiness({ authMethod: "api_key", providerKind: "anthropic" })).toBe(true);
    expect(showsChatReadiness({ authMethod: "api_key", providerKind: "openai-compatible" })).toBe(
      true
    );
    expect(showsChatReadiness({ authMethod: "api_key", providerKind: "google" })).toBe(false);
    expect(showsChatReadiness({ authMethod: "cli", providerKind: "anthropic" })).toBe(false);
  });
});
