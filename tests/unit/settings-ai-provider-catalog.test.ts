import { describe, expect, it } from "vitest";

import {
  PROVIDER_CATALOG,
  PROVIDER_GROUPS,
  SUBSCRIPTION_TAKEN_NOTE,
  nextFreeName,
  subscriptionChoiceTaken
} from "../../apps/web/src/settings/settings-ai-provider-catalog.js";

describe("provider catalog", () => {
  it("groups every choice by how it connects, with a plain line each", () => {
    const groups = new Set(PROVIDER_GROUPS.map((group) => group.id));
    for (const entry of PROVIDER_CATALOG) {
      expect(groups.has(entry.group)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(0);
    }
    const byGroup = (id: string) =>
      PROVIDER_CATALOG.filter((entry) => entry.group === id).map((entry) => entry.label);
    expect(byGroup("subscription")).toEqual(["Claude", "Codex", "Gemini", "OpenCode"]);
    expect(byGroup("api-key")).toEqual([
      "OpenAI-compatible",
      "Anthropic",
      "Google",
      "Ollama (local)"
    ]);
    expect(byGroup("decision")).toEqual(["Jev", "Clef", "Any compatible service"]);
  });

  it("keeps every id and label unique", () => {
    expect(new Set(PROVIDER_CATALOG.map((e) => e.id)).size).toBe(PROVIDER_CATALOG.length);
    expect(new Set(PROVIDER_CATALOG.map((e) => e.label)).size).toBe(PROVIDER_CATALOG.length);
  });

  it("uses subscription sign-in for exactly the subscription group", () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.authMethod === "cli").toBe(entry.group === "subscription");
    }
  });

  it("disables only a subscription choice that already has a provider", () => {
    const claude = PROVIDER_CATALOG.find((e) => e.id === "claude")!;
    const codex = PROVIDER_CATALOG.find((e) => e.id === "codex")!;
    const opencode = PROVIDER_CATALOG.find((e) => e.id === "opencode")!;
    const apiKey = PROVIDER_CATALOG.find((e) => e.id === "anthropic")!;
    const existing = [
      {
        providerKind: "anthropic" as const,
        authMethod: "cli" as const,
        displayName: "Claude",
        // The server fills this in for Claude, so a real Claude row always carries it.
        acpAgentId: "claude-acp"
      },
      {
        providerKind: "openai-compatible" as const,
        authMethod: "cli" as const,
        displayName: "Codex",
        acpAgentId: "codex-acp"
      }
    ];
    const gemini = PROVIDER_CATALOG.find((e) => e.id === "gemini")!;
    expect(subscriptionChoiceTaken(claude, existing)).toBe(true);
    expect(subscriptionChoiceTaken(gemini, existing)).toBe(false);
    expect(
      subscriptionChoiceTaken(gemini, [
        {
          providerKind: "google" as const,
          authMethod: "cli" as const,
          displayName: "Gemini",
          acpAgentId: "gemini-acp"
        }
      ])
    ).toBe(true);
    expect(subscriptionChoiceTaken(codex, existing)).toBe(true);
    expect(subscriptionChoiceTaken(opencode, existing)).toBe(false);
    // An API key provider of the same company never blocks anything, in either direction.
    expect(subscriptionChoiceTaken(apiKey, existing)).toBe(false);
    expect(subscriptionChoiceTaken(claude, [{ ...existing[0]!, authMethod: "api_key" }])).toBe(
      false
    );
    expect(SUBSCRIPTION_TAKEN_NOTE).toBe(
      "Already connected. Remove it to sign in with another account."
    );
  });

  it("prefills the next free name", () => {
    expect(nextFreeName("Claude", [])).toBe("Claude");
    expect(nextFreeName("Claude", ["Claude"])).toBe("Claude 2");
    expect(nextFreeName("Claude", ["claude", "Claude 2"])).toBe("Claude 3");
  });
});
