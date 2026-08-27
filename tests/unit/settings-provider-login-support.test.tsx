/**
 * (#2027) The Settings AI pane shows its "Log in" button — and the "Re-authenticate" wording on an
 * already-connected provider — only when `supportsAutomatedProviderLogin` says yes for that
 * provider card (settings-ai-admin-pane.tsx). Before this suite the rule had no test of any kind,
 * so the Gemini card could have silently stopped offering the button again with CI still green.
 *
 * The rule itself: sign-in is offered when the provider authenticates through its command-line
 * tool, that tool is actually present on this stack, AND the tool is one the server has a sign-in
 * adapter for. Anything else falls back to the manual terminal.
 */
import { describe, expect, it } from "vitest";

import type { AiProviderConfigDto, AiProviderKind } from "@moss/shared";

import { supportsAutomatedProviderLogin } from "../../apps/web/src/settings/settings-provider-login-dialog.js";

function providerCard(overrides: Partial<AiProviderConfigDto> = {}): AiProviderConfigDto {
  return {
    id: "cfg-1",
    providerKind: "google",
    displayName: "Gemini",
    baseUrl: null,
    status: "active",
    authMethod: "cli",
    executionMode: "interactive",
    hasCredential: false,
    cliAvailable: true,
    isInstanceDefault: false,
    revokedAt: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides
  };
}

describe("Settings: which providers offer a sign-in button (#2027)", () => {
  const withAdapters: readonly AiProviderKind[] = ["anthropic", "openai-compatible", "google"];

  for (const providerKind of withAdapters) {
    it(`offers sign-in for ${providerKind} when its tool is installed`, () => {
      expect(supportsAutomatedProviderLogin(providerCard({ providerKind }))).toBe(true);
    });
  }

  it("offers sign-in for the Gemini tool — the case #2027 added", () => {
    // Named separately from the loop above so a regression here reads as its own failure.
    expect(supportsAutomatedProviderLogin(providerCard({ providerKind: "google" }))).toBe(true);
  });

  it("does not offer sign-in when the tool is not installed on this stack", () => {
    expect(supportsAutomatedProviderLogin(providerCard({ cliAvailable: false }))).toBe(false);
  });

  it("does not offer sign-in for a provider configured with an API key instead", () => {
    expect(
      supportsAutomatedProviderLogin(providerCard({ authMethod: "api_key", hasCredential: true }))
    ).toBe(false);
  });

  it("does not offer sign-in for a provider kind with no adapter behind it", () => {
    // ollama has no sign-in adapter; the card falls back to the manual terminal.
    expect(supportsAutomatedProviderLogin(providerCard({ providerKind: "ollama" }))).toBe(false);
  });
});
