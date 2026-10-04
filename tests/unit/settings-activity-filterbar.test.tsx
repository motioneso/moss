// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionAuditLogEntryDto, ActivityLineDto, MeResponse } from "@moss/shared";

const LINES: ActivityLineDto[] = [
  {
    id: "line-a",
    occurredAt: "2026-10-03T09:41:00.000Z",
    kind: "chat",
    action: "chat",
    outcome: "ok",
    modelName: "model-a",
    result: "done",
    ownerUserId: "u1",
    actionCode: "chat.answer",
    turnId: "t1",
    parentId: null,
    durationMs: 1000,
    inputTokens: 10,
    outputTokens: 5,
    failureCode: null,
    factCounts: null,
    detail: null
  },
  {
    id: "line-b",
    occurredAt: "2026-10-03T08:00:00.000Z",
    kind: "structured",
    action: "news",
    outcome: "ok",
    modelName: "model-b",
    result: "done",
    ownerUserId: "u1",
    actionCode: "structured.news",
    turnId: null,
    parentId: null,
    durationMs: 2000,
    inputTokens: 20,
    outputTokens: 10,
    failureCode: null,
    factCounts: null,
    detail: null
  },
  {
    id: "line-sys",
    occurredAt: "2026-10-03T07:00:00.000Z",
    kind: "probe",
    action: "probe",
    outcome: "ok",
    modelName: "model-a",
    result: "done",
    ownerUserId: null,
    actionCode: "probe.reachable",
    turnId: null,
    parentId: null,
    durationMs: 500,
    inputTokens: null,
    outputTokens: null,
    failureCode: null,
    factCounts: null,
    detail: null
  }
];

const AUDITS: ActionAuditLogEntryDto[] = [
  {
    id: "tool-1",
    ownerUserId: "u1",
    toolModuleId: "calendar",
    toolName: "calendar.createEvent",
    actionFamilyId: null,
    actionKind: "write",
    approvalMode: "auto",
    outcome: "success",
    errorClass: null,
    requestId: null,
    chatSessionId: null,
    turnId: null,
    sourceSurface: "chat",
    inputSummary: null,
    durationMs: 100,
    occurredAt: "2026-10-03T09:40:00.000Z"
  }
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: { queryKey?: unknown }) => {
    const key = JSON.stringify(options.queryKey ?? []);
    if (key.includes("activity-lines")) {
      return { data: { entries: LINES }, isLoading: false, isError: false, refetch: vi.fn() };
    }
    if (key.includes("action-audit-log")) {
      return { data: { entries: AUDITS }, isLoading: false, isError: false, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  })
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  listActivityLines: vi.fn(),
  listActionAuditLog: vi.fn(),
  getPersonaSettings: vi.fn()
}));

vi.mock("../../apps/web/src/locale/locale-format.js", () => ({
  formatDate: vi.fn(() => "October 3, 2026"),
  formatDateTime: vi.fn(() => "October 3, 2026"),
  formatTime: vi.fn(() => "09:41"),
  useUserLocale: vi.fn(() => ({ timezone: "UTC", region: "en-US", dateFormat: "24" }))
}));

import { ActivityPane } from "../../apps/web/src/settings/settings-activity-pane.js";

function meFor(userId: string, isAdmin: boolean): MeResponse {
  return {
    user: {
      id: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      name: "U",
      status: "active",
      isInstanceAdmin: isAdmin,
      isBootstrapOwner: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(() => {
  if (root) unmount();
  window.localStorage.clear();
});

function pane(me: MeResponse) {
  return <ActivityPane me={me} onNavigate={() => undefined} />;
}

function click(element: Element | null) {
  if (!element) throw new Error("expected an element to click");
  act(() => {
    (element as HTMLElement).click();
  });
}

function openChecklist() {
  click(host?.querySelector(".act-filters__models > button") ?? null);
}

function tickModel(label: string) {
  const items = [...(host?.querySelectorAll(".jds-checklist__item") ?? [])];
  const row = items.find((item) => item.textContent?.includes(label));
  if (!row) throw new Error(`no checklist row for ${label}`);
  click(row.querySelector('input[type="checkbox"]'));
}

describe("ActivityPane filter bar (#2956 slice D)", () => {
  it("starts with every model ticked, no note and no reset", () => {
    mount(pane(meFor("filter-admin-1", true)));

    expect(host?.textContent).toContain("Models: all");
    expect(host?.textContent).not.toContain("hidden by the model filter");
    expect(host?.textContent).not.toContain("Reset filters");
    expect(host?.textContent).toContain("Answered a chat message");
    expect(host?.textContent).toContain("Ranked your news stories");
  });

  it("offers the loaded modules plus System for admins", () => {
    mount(pane(meFor("filter-admin-2", true)));

    const options = [...(host?.querySelectorAll(".act-filters select option") ?? [])].map(
      (option) => option.textContent
    );
    expect(options).toContain("All modules");
    expect(options).toContain("Assistant");
    expect(options).toContain("Calendar");
    expect(options).toContain("News");
    expect(options).toContain("System");
  });

  it("hides System from non-admins", () => {
    mount(pane(meFor("filter-user-1", false)));

    const options = [...(host?.querySelectorAll(".act-filters select option") ?? [])].map(
      (option) => option.textContent
    );
    expect(options).not.toContain("System");
  });

  it("unticking a model hides its lines with a note, and Reset restores them", () => {
    mount(pane(meFor("filter-admin-3", true)));
    openChecklist();
    expect(host?.textContent).toContain("model-b");

    tickModel("model-b");
    expect(host?.textContent).not.toContain("Ranked your news stories");
    expect(host?.textContent).toContain("Answered a chat message");
    expect(host?.textContent).toContain("1 entry hidden by the model filter");
    expect(host?.textContent).toContain("Models: 2 of 3");
    expect(host?.textContent).toContain("Reset filters");

    click(
      [...(host?.querySelectorAll(".act-filters button") ?? [])].find(
        (button) => button.textContent === "Reset filters"
      ) ?? null
    );
    expect(host?.textContent).toContain("Ranked your news stories");
    expect(host?.textContent).toContain("Models: all");
    expect(host?.textContent).not.toContain("hidden by the model filter");
  });

  it("keeps unticked models across a reload and Tick all restores them", () => {
    mount(pane(meFor("filter-admin-4", true)));
    openChecklist();
    tickModel("model-b");
    expect(host?.textContent).toContain("Models: 2 of 3");
    unmount();

    mount(pane(meFor("filter-admin-4", true)));
    expect(host?.textContent).toContain("Models: 2 of 3");
    expect(host?.textContent).not.toContain("Ranked your news stories");

    openChecklist();
    click(
      [...(host?.querySelectorAll(".jds-checklist__foot button") ?? [])].find(
        (button) => button.textContent === "Tick all"
      ) ?? null
    );
    expect(host?.textContent).toContain("Models: all");
    expect(host?.textContent).toContain("Ranked your news stories");
  });
});
