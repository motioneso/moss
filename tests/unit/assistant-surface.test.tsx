import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  AssistantSurface,
  AssistantSurfaceHostProvider
} from "../../apps/web/src/chat/assistant-surface/index.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import type { TranscriptRecord } from "../../apps/web/src/chat/use-chat-stream.js";

// The surface reads the configured assistant name via useAssistantName (react-query), so every
// render needs a QueryClientProvider ancestor. "Alfred" (not "Moss") keeps assertions here about
// the ASSISTANT name unambiguous from the fixed PRODUCT name "Moss" (#1441).
function withPersonaQueryClient(child: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.settings.persona, {
    persona: { assistantName: "Alfred", personaText: "" }
  });
  return createElement(QueryClientProvider, { client }, child);
}

const records: readonly TranscriptRecord[] = [
  { kind: "thinking", text: "hidden thought" },
  { kind: "user", text: "Streamed user" },
  { kind: "reply", text: "**Streamed reply**" },
  {
    kind: "action_request",
    text: "Approve profile",
    actionRequestId: "ar-1",
    toolName: "demo-module.profile.approve",
    summary: "Approve profile"
  },
  { kind: "action_result", text: "Profile approved", outcome: "executed" },
  { kind: "error", text: "Visible failure" }
];

describe("AssistantSurface", () => {
  it("renders scripted rows, default live records, typing, then the active control", () => {
    const html = renderToString(
      withPersonaQueryClient(
        createElement(
          AssistantSurfaceHostProvider,
          {
            value: {
              records,
              registerComposer: () => () => undefined,
              subscribeRecords: () => () => undefined
            }
          },
          createElement(AssistantSurface, {
            localRows: [
              { id: "intro", role: "assistant", content: "Scripted intro" },
              { id: "answer", role: "user", content: "Scripted answer" }
            ],
            activeControl: createElement("button", { type: "button" }, "Choose sources"),
            typing: true
          })
        )
      )
    );

    expect(html).not.toContain("hidden thought");
    expect(html).toContain("<strong>Streamed reply</strong>");
    expect(html).toContain("Approve profile");
    expect(html).toContain("Profile approved");
    expect(html).toContain("Visible failure");
    expect(html).toContain('aria-label="Alfred is typing"');
    expect(html.indexOf("Scripted intro")).toBeLessThan(html.indexOf("Streamed user"));
    expect(html.indexOf("Streamed user")).toBeLessThan(html.indexOf("Choose sources"));
  });

  it("honors an explicit record-kind filter", () => {
    const html = renderToString(
      withPersonaQueryClient(
        createElement(
          AssistantSurfaceHostProvider,
          {
            value: {
              records,
              registerComposer: () => () => undefined,
              subscribeRecords: () => () => undefined
            }
          },
          createElement(AssistantSurface, { recordKinds: ["reply"] })
        )
      )
    );

    expect(html).toContain("Streamed reply");
    expect(html).not.toContain("Streamed user");
    expect(html).not.toContain("Approve profile");
  });

  it("marks the transcript container as a live region so appended rows are announced (#1207)", () => {
    const html = renderToString(
      withPersonaQueryClient(
        createElement(
          AssistantSurfaceHostProvider,
          {
            value: {
              records,
              registerComposer: () => () => undefined,
              subscribeRecords: () => () => undefined
            }
          },
          createElement(AssistantSurface, {})
        )
      )
    );

    expect(html).toContain('class="assistant-surface__thread" aria-live="polite"');
  });

  it("renders records from the requested surface only", () => {
    const html = renderToString(
      withPersonaQueryClient(
        createElement(
          AssistantSurfaceHostProvider,
          {
            value: {
              records,
              recordsForSurface: (surface) =>
                surface === "demo-module"
                  ? [{ kind: "reply", text: "Demo Module reply" }]
                  : records,
              registerComposer: () => () => undefined,
              subscribeRecords: () => () => undefined
            }
          },
          createElement(AssistantSurface, { surface: "demo-module" })
        )
      )
    );

    expect(html).toContain("Demo Module reply");
    expect(html).not.toContain("Streamed reply");
  });
});
