// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Group, PaneHead } from "@moss/settings-ui";
import { SectionHead } from "@moss/ui";
import type { ApprovedActionScopeDto, ScheduledTaskDto } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import type { MemoryDashboardItem } from "../../apps/web/src/api/memory-client.js";
import { ApprovedActionScopeDetail } from "../../apps/web/src/settings/approved-action-scopes.js";
import { IntegrationToolsSection } from "../../apps/web/src/settings/integration-tool-groups.js";
import { ScheduledTaskDetail } from "../../apps/web/src/settings/scheduled-task-detail.js";
import { MemoryDashboardPane } from "../../apps/web/src/settings/settings-memory-dashboard.js";
import { SettingsPeoplePane } from "../../apps/web/src/settings/settings-people-pane.js";
import { SourcesPane } from "../../apps/web/src/settings/settings-personal-data-panes.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import EmailSettings from "../../packages/email/src/settings/index.js";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let style: HTMLStyleElement | undefined;
const chatControls = {
  openChat: () => {},
  openChatThread: () => {},
  openChatWith: () => {},
  openAssistantWithDraft: () => {}
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
  });
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  client.setQueryData(queryKeys.settings.persona, { persona: { assistantName: "Moss" } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  style?.remove();
  style = undefined;
  client.clear();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChatControlsProvider value={chatControls}>
          <FeedbackProvider>{node}</FeedbackProvider>
        </ChatControlsProvider>
      </QueryClientProvider>
    );
  });
}

async function click(label: string, within: ParentNode = host) {
  const button = [...within.querySelectorAll("button")].find(
    (element) =>
      element.textContent === label ||
      element.getAttribute("aria-label") === label ||
      element.getAttribute("title") === label
  );
  expect(button, `button: ${label}`).toBeDefined();
  await act(async () => button!.click());
}

function headingOutline() {
  return [...host.querySelectorAll("h2, h3, h4, h5, h6")].map((element) => [
    element.tagName,
    element.textContent
  ]);
}

function loadDetailStyles() {
  const read = (path: string) => readFileSync(resolve(path), "utf8");
  const tokenBlock =
    /:root[^{]*\{([^}]+)\}/.exec(read("apps/web/src/styles/tokens.css"))?.[1] ?? "";
  const tokens = new Map(
    [...tokenBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!])
  );
  // jsdom needs shipped custom-property values substituted to test the CSS cascade.
  // These computed roles do not establish browser font loading, wrapping or layout.
  const resolveTokens = (value: string): string =>
    value.replace(/var\((--[\w-]+)\)/g, (original, name: string) => {
      const token = tokens.get(name);
      return token ? resolveTokens(token) : original;
    });
  style = document.createElement("style");
  style.textContent = resolveTokens(
    read("packages/ui/src/styles/components-sections.css") +
      read("apps/web/src/styles/settings-scheduled-tasks.css")
  );
  document.head.append(style);
}

describe("settings heading hierarchy", () => {
  it("exposes default and nested Group titles below PaneHead without changing their class", async () => {
    await render(
      <>
        <PaneHead title="Connections" />
        <Group title="Tools">
          <Group title="Read tools" titleAs="h4">
            Available tools
          </Group>
        </Group>
      </>
    );
    expect(headingOutline()).toEqual([
      ["H2", "Connections"],
      ["H3", "Tools"],
      ["H4", "Read tools"]
    ]);
    expect(host.querySelectorAll(".pane__cardtitle")).toHaveLength(2);
  });

  it("puts integration risk groups below the Tools heading", async () => {
    await render(
      <>
        <PaneHead title="Fixture connection" />
        <IntegrationToolsSection
          detail={{
            tools: [{ name: "lookup", description: "Read data", group: "", inputSchema: null }],
            groups: [],
            enabledGroups: [],
            enabledTools: [],
            mutedTools: [],
            groupOptIn: false,
            classifierTools: [
              {
                toolName: "lookup",
                status: "current",
                risk: "read",
                failure: null,
                sendWithoutAsking: false,
                asksFirst: false,
                readableName: "Look up data",
                sortedAt: "2026-10-15T09:00:00Z",
                sortedBy: null,
                sortMethod: null,
                failedAt: null,
                keptOut: false,
                classifierState: "off",
                preparationFailure: null,
                preparedAt: null
              }
            ]
          }}
          onSetOn={() => {}}
          onSendWithoutAsking={() => {}}
          onSetKeptOut={() => {}}
        />
      </>
    );
    expect(headingOutline()).toEqual([
      ["H2", "Fixture connection"],
      ["H3", "Tools"],
      ["H4", "Looks things up1 of 1 on"]
    ]);
  });

  it("puts scheduled run history below the focused task title", async () => {
    loadDetailStyles();
    const task: ScheduledTaskDto = {
      id: "scheduled-one",
      title: "A long reminder title that can wrap",
      instruction: "Remember this task",
      group: "Reminders",
      state: "active",
      dueAt: "2026-10-15T12:00:00Z",
      deadlineAt: null,
      createdAt: "2026-10-15T09:00:00Z",
      runs: []
    };
    await render(
      <>
        <PaneHead title="Scheduled tasks" />
        <ScheduledTaskDetail task={task} onBack={() => {}} />
        <SectionHead title="Standalone section" titleAs="h3" />
      </>
    );
    expect(headingOutline()).toEqual([
      ["H2", "Scheduled tasks"],
      ["H3", task.title],
      ["H4", "Run history"],
      ["H3", "Standalone section"]
    ]);
    expect(document.activeElement).toBe(host.querySelector("h3"));
    const title = getComputedStyle(host.querySelector(".scheduled-task-detail__title")!);
    const subsection = getComputedStyle(
      host.querySelector(".scheduled-task-detail__section-title")!
    );
    for (const heading of [title, subsection]) {
      expect(heading.fontFamily).toContain("Archivo");
      expect(heading.fontWeight).toBe("800");
    }
    expect(title.fontSize).toBe("24px");
    expect(title.lineHeight).toBe("1.15");
    expect(subsection.fontSize).toBe("20px");
    expect(subsection.lineHeight).toBe("1.3");
    const outside = getComputedStyle(host.querySelector("h3.jds-section-head__title")!);
    expect(outside.fontSize).toBe("25px");
    expect(outside.fontWeight).toBe("700");
    const body = getComputedStyle(host.querySelector(".scheduled-task-detail")!);
    expect(body.fontSize).toBe("13px");
    expect(body.lineHeight).toBe("1.65");
  });

  it("keeps approved scopes explicitly inactive beneath their detail title", async () => {
    const agreement: ApprovedActionScopeDto = {
      id: "agreement-one",
      version: 1,
      state: "not_active",
      approvedAt: "2026-10-15T09:00:00Z",
      scope: {
        operation: "tasks.updateStatus",
        taskId: "task-one",
        taskTitle: "Read the report",
        status: "done",
        dueAt: "2026-10-16T09:00:00Z",
        timeZone: "UTC",
        destinationThreadId: "main"
      }
    };
    await render(<ApprovedActionScopeDetail agreement={agreement} onBack={() => {}} />);
    expect(headingOutline()).toEqual([
      ["H3", "Mark Read the report done"],
      ["H4", "Agreed action scope"]
    ]);
    expect(host.textContent).toContain("no change will run");
    expect(host.textContent).toContain("No other changes are approved.");
    expect(host.textContent).toContain("This agreement cannot be resumed.");
  });
});

describe("memory review wording follows the selected view and action", () => {
  it("uses distinct empty states when switching review, saved and history views", async () => {
    client.setQueryData(queryKeys.memory.dashboard({}), { counts: { pending: 2 }, items: [] });
    for (const status of ["pending", "active", "history"])
      client.setQueryData(queryKeys.memory.dashboard({ status }), { counts: {}, items: [] });
    await render(<MemoryDashboardPane />);
    expect(host.textContent).toContain("To review (2)");
    expect(host.textContent).toContain("No memories to review.");
    await click("Saved memories");
    expect(host.textContent).toContain("No saved memories yet.");
    expect(host.textContent).not.toContain("No memories to review.");
    await click("History");
    expect(host.textContent).toContain("No memory history yet.");
    expect(host.textContent).not.toContain("No saved memories yet.");
  });

  it.each([
    ["Stop suggesting", "Stop suggesting this memory?", "suppress"],
    ["Reject", "Reject this candidate?", "reject"]
  ])("keeps %s on its own confirmation and endpoint", async (label, title, endpoint) => {
    const item: MemoryDashboardItem = {
      itemKind: "candidate",
      id: "candidate-one",
      title: "Prefer morning meetings",
      summary: "Prefer morning meetings",
      status: "pending",
      sourceSummary: "Chat",
      sourceKind: "chat",
      createdAt: "2026-10-15T09:00:00Z",
      updatedAt: "2026-10-15T09:00:00Z",
      editableFields: []
    };
    client.setQueryData(queryKeys.memory.dashboard({}), { counts: { pending: 1 }, items: [item] });
    client.setQueryData(queryKeys.memory.dashboard({ status: "pending" }), {
      counts: { pending: 1 },
      items: [item]
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await render(<MemoryDashboardPane />);
    await act(async () => host.querySelector<HTMLButtonElement>(".memdash-item__header")!.click());
    await click(label);
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(title);
    if (endpoint === "suppress")
      expect(dialog.textContent).toContain("It won't appear for review again.");
    expect(fetchMock).not.toHaveBeenCalled();
    await click(label, dialog);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/memory/candidates/candidate-one/${endpoint}`,
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("settings copy preserves the underlying controls", () => {
  it("distinguishes briefing suggestions, task capture, draft saving and send approval", async () => {
    client.setQueryData(["settings", "source-behaviors"], { sources: [] });
    client.setQueryData(["email", "briefing-settings"], {
      settings: { createTasks: true, suggestReplies: true, draftReplies: true, autoSend: false }
    });
    client.setQueryData(["email", "task-mode"], { mode: "suggest" });
    client.setQueryData(["ai", "action-policy"], { policies: [] });
    await render(<EmailSettings />);
    expect(host.textContent).toContain("Automatic task capture uses the Task creation setting.");
    expect(host.textContent).toContain("Sending still follows your email approval rules.");
    expect(host.textContent).toContain("Turning this on does not change those rules.");
    expect(host.textContent).toContain(
      "This only saves a draft. Sending a reply is a separate action"
    );
    expect(host.querySelector('input[aria-label="Suggest tasks in briefings"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="Suggest sending replies"]')).not.toBeNull();
    expect(headingOutline()).toContainEqual(["H3", "Automatic drafts"]);
  });

  it("reports processed People and review items while retaining every detailed count", async () => {
    client.setQueryData(queryKeys.people.notesSettings, { folder: "/notes/People" });
    client.setQueryData(queryKeys.people.list, { people: [] });
    client.setQueryData(queryKeys.people.matchCandidates, { candidates: [] });
    client.setQueryData(queryKeys.settings.sourceBehaviors, { sources: [] });
    const refreshResult = { discovered: 8, projected: 3, ignored: 2, candidates: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (path: string) =>
          new Response(
            JSON.stringify(
              path === "/api/people/notes/refresh"
                ? refreshResult
                : path.startsWith("/api/people/match-candidates")
                  ? { candidates: [] }
                  : { people: [] }
            ),
            { status: 200 }
          )
      )
    );
    await render(<SettingsPeoplePane />);
    await click("Refresh");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(host.textContent).toContain("Synced 3 people. 1 item needs review.");
    for (const count of [
      "Files found: 8",
      "people synced: 3",
      "files ignored: 2",
      "items needing review: 1"
    ])
      expect(host.textContent).toContain(count);
  });

  it("describes linked Notes as a sync, including already saved notes", async () => {
    client.setQueryData(queryKeys.settings.notesSource, { path: "/notes" });
    client.setQueryData(queryKeys.settings.notesLastSync, { lastSync: null });
    await render(<SourcesPane embedded />);
    expect(host.textContent).toContain("Choose a folder of Markdown notes on this server.");
    expect(host.textContent).toContain("Folder linked. Choose Sync now to sync its notes.");
  });
});
