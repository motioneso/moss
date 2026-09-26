import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { AiProviderConfigDto } from "@moss/shared";

// #1059 — root suite renders @moss/web components with react-dom/server (no jsdom /
// @testing-library — deliberately avoided repo-wide; see settings-appearance-pane.test.tsx).
// useQuery reads primed cache synchronously during renderToString, so the resolved
// state (no-password vs locked) is asserted against the SSR HTML string. The xterm
// mount + live WebSocket byte-bridge never runs under renderToString (no effects, no
// real DOM, no WebSocket) — that path is exercised only by real dev UAT (Task 10),
// mirroring Task 7's identical deferral for the server-side cli-runner byte bridge.
import {
  buildResizeMessage,
  nextTerminalModalPhase,
  TerminalModal
} from "../../apps/web/src/settings/terminal-modal.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

function provider(overrides: Partial<AiProviderConfigDto> = {}): AiProviderConfigDto {
  return {
    id: "p1",
    providerKind: "anthropic",
    displayName: "Claude",
    acpAgentId: "claude-acp",
    authMethod: "cli",
    hasCredential: false,
    cliAvailable: true,
    baseUrl: null,
    status: "active",
    isInstanceDefault: false,
    revokedAt: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function renderModal(passwordSet: boolean): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.ai.terminalStatus("p1"), { passwordSet });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        FeedbackProvider,
        null,
        createElement(TerminalModal, { provider: provider(), onClose: () => {} })
      )
    )
  );
}

describe("buildResizeMessage (#1059)", () => {
  it("returns the exact resize JSON text frame shape the server expects", () => {
    expect(buildResizeMessage(80, 24)).toBe('{"type":"resize","cols":80,"rows":24}');
  });
});

describe("nextTerminalModalPhase (#1059)", () => {
  it("routes an unset password to the set-password phase", () => {
    expect(nextTerminalModalPhase(null, { type: "status", passwordSet: false })).toEqual({
      kind: "set-password"
    });
  });

  it("routes an already-set password to the locked phase", () => {
    expect(nextTerminalModalPhase(null, { type: "status", passwordSet: true })).toEqual({
      kind: "locked"
    });
  });

  it("advances set-password -> locked once the password is created", () => {
    expect(nextTerminalModalPhase({ kind: "set-password" }, { type: "password-set" })).toEqual({
      kind: "locked"
    });
  });

  it("advances locked -> unlocked once a ticket is issued", () => {
    expect(
      nextTerminalModalPhase({ kind: "locked" }, { type: "ticket", ticket: "tk-123" })
    ).toEqual({ kind: "unlocked", ticket: "tk-123" });
  });
});

describe("TerminalModal (#1059) — SSR smoke per reachable static state", () => {
  it("prompts to set a terminal password when the status query resolves passwordSet: false", () => {
    const html = renderModal(false);
    expect(html).toContain("Set a terminal password");
  });

  it("prompts for the terminal password when the status query resolves passwordSet: true", () => {
    const html = renderModal(true);
    expect(html).toContain("Enter your terminal password");
  });
});
