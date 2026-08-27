import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import type { MatchCandidateDto } from "../../apps/web/src/api/people-client.js";
import {
  getPeopleRefreshGuidance,
  SettingsPeoplePane
} from "../../apps/web/src/settings/settings-people-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

function renderWithQuery(node: React.ReactNode, client: QueryClient): string {
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(FeedbackProvider, null, node))
  );
}

function renderPane(folder: string | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.people.notesSettings, { folder });
  client.setQueryData(queryKeys.people.list, { people: [] });
  client.setQueryData(queryKeys.people.matchCandidates, { candidates: [] });
  client.setQueryData(queryKeys.settings.sourceBehaviors, { sources: [] });
  return renderWithQuery(createElement(SettingsPeoplePane), client);
}

describe("SettingsPeoplePane", () => {
  it("returns actionable zero-discovered and ignored-file guidance", () => {
    expect(
      getPeopleRefreshGuidance({ discovered: 0, projected: 0, ignored: 2, candidates: 0 })
    ).toEqual([
      "Choose another folder or add a person manually.",
      "Ignored files need valid People-note frontmatter."
    ]);
    expect(
      getPeopleRefreshGuidance({ discovered: 2, projected: 2, ignored: 0, candidates: 0 })
    ).toEqual([]);
  });

  it("disables manual fields without a folder and lists synchronized People first", () => {
    const html = renderPane(null);
    expect(html).toMatch(/aria-label="Person name"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Person email"[^>]*disabled=""/);
    expect(html.indexOf("No people yet")).toBeLessThan(html.indexOf("Add a person manually"));
  });

  it("enables manual fields and exposes clear recovery with a configured folder", () => {
    const html = renderPane("People");
    expect(html).not.toMatch(/aria-label="Person name"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Person email"[^>]*disabled=""/);
    expect(html).toContain("Clear folder");
  });

  it("starts directly with the People controls without a duplicate pane heading", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderWithQuery(createElement(SettingsPeoplePane), client);
    expect(html).toContain("People notes");
    expect(html).not.toContain("People &amp; context");
  });

  it("shows Review matches section", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderWithQuery(createElement(SettingsPeoplePane), client);
    expect(html).toContain("Review matches");
  });

  it("renders a pending candidate row when data is present", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const candidate: MatchCandidateDto = {
      id: "cand-1",
      candidateKind: "link_identity",
      status: "pending",
      suggestedDisplayName: "Alice Smith",
      reasonSummary: "Same email seen in two sources",
      confidence: 0.9
    };
    client.setQueryData(queryKeys.people.matchCandidates, { candidates: [candidate] });
    const html = renderWithQuery(createElement(SettingsPeoplePane), client);
    expect(html).toContain("Alice Smith");
  });

  it("shows destructive warning banner for merge_people candidates", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const candidate: MatchCandidateDto = {
      id: "cand-2",
      candidateKind: "merge_people",
      status: "pending",
      suggestedDisplayName: "Bob Jones",
      reasonSummary: "Likely same person",
      confidence: 0.85
    };
    client.setQueryData(queryKeys.people.matchCandidates, { candidates: [candidate] });
    const html = renderWithQuery(createElement(SettingsPeoplePane), client);
    expect(html).toContain("confirm in chat");
  });

  it("shows the suggest note updates toggle reflecting a disabled override", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.sourceBehaviors, {
      sources: [
        {
          id: "people-notes",
          name: "People notes",
          description: "People records projected from the configured People notes folder.",
          behaviors: [
            {
              id: "people.notes.suggest-updates",
              sourceId: "people-notes",
              name: "Suggest note updates",
              description: "",
              default: "default-on",
              enabled: false,
              toggleable: true
            }
          ]
        }
      ]
    });
    const html = renderWithQuery(createElement(SettingsPeoplePane), client);
    expect(html).toContain("Suggest note updates");
    expect(html).not.toContain('checked=""');
  });

  it("defaults the suggest note updates toggle to on with no override present", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderWithQuery(createElement(SettingsPeoplePane), client);
    expect(html).toContain("Suggest note updates");
    expect(html).toContain('checked=""');
  });
});
