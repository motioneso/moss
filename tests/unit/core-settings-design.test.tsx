import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import { MemoryDashboardPane } from "../../apps/web/src/settings/settings-memory-dashboard.js";
import { SettingsPeoplePane } from "../../apps/web/src/settings/settings-people-pane.js";
import { OversightPane } from "../../apps/web/src/settings/settings-admin-panes.js";
import { ModuleOwnPageLink } from "../../apps/web/src/settings/settings-module-own-page-link.js";
import { DeleteAccount } from "../../apps/web/src/settings/delete-account.js";
import type { MeResponse } from "@moss/shared";
import { AppearancePane } from "../../apps/web/src/settings/settings-appearance-pane.js";
import { EncryptionKeysPane } from "../../apps/web/src/settings/settings-encryption-keys-pane.js";
import type * as ClientModule from "../../apps/web/src/api/client.js";
import { rotateFamilyKey, deleteCustomTheme } from "../../apps/web/src/api/client.js";
import { ProfilePane } from "../../apps/web/src/settings/settings-personal-panes.js";
import { OpenCodeAcpCard } from "../../apps/web/src/settings/settings-ai-opencode-card.js";
import { SettingsSkillsPane } from "../../apps/web/src/settings/settings-skills-pane.js";
import { AuditPane } from "../../apps/web/src/settings/settings-audit-pane.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  rotateFamilyKey: vi.fn(),
  deleteCustomTheme: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
  });
}

function fail(queryClient: QueryClient, queryKey: QueryKey) {
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey })
    .setState({
      status: "error",
      fetchStatus: "idle",
      error: new Error("Fixture read unavailable")
    });
}

function render(node: ReactNode, queryClient: QueryClient): string {
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <FeedbackProvider>{node}</FeedbackProvider>
    </QueryClientProvider>
  );
}

describe("core settings truthful read states", () => {
  it("gives a failed Memory read a real retry without claiming the list is empty", () => {
    const queryClient = client();
    fail(queryClient, queryKeys.memory.dashboard({ status: "pending" }));
    const html = render(<MemoryDashboardPane />, queryClient);
    expect(html).toContain("Could not load memories.");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Nothing here");
  });

  it("keeps confirmed Memory rows visible after a refresh failure", () => {
    const queryClient = client();
    const queryKey = queryKeys.memory.dashboard({ status: "pending" });
    queryClient.setQueryData(queryKey, {
      counts: { pending: 1 },
      items: [
        {
          itemKind: "candidate",
          id: "candidate-test",
          title: "Morning focus",
          summary: "Quiet mornings",
          status: "pending",
          sourceSummary: "Fixture",
          sourceKind: "chat",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          editableFields: []
        }
      ]
    });
    fail(queryClient, queryKey);
    const html = render(<MemoryDashboardPane />, queryClient);
    expect(html).toContain("Could not load memories.");
    expect(html).toContain("Morning focus");
    expect(html).toContain("jds-disclosure");
    expect(html).toContain('aria-expanded="false"');
    const controlled = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controlled).toBeTruthy();
    expect(html).toContain(`id="${controlled}" hidden=""`);
  });

  it("does not announce empty People or match lists while loading", () => {
    const html = render(<SettingsPeoplePane />, client());
    expect(html).toContain("Loading match candidates");
    expect(html).toContain("Loading people");
    expect(html).not.toContain("Nothing to review");
    expect(html).not.toContain("No people yet");
    expect(html).not.toContain("No People folder configured");
  });

  it("separates failed People reads from successful empty lists", () => {
    const queryClient = client();
    fail(queryClient, queryKeys.people.list);
    fail(queryClient, queryKeys.people.matchCandidates);
    fail(queryClient, queryKeys.people.notesSettings);
    const html = render(<SettingsPeoplePane />, queryClient);
    expect(html).toContain("Could not load people.");
    expect(html).toContain("Could not load match candidates.");
    expect(html).toContain("Could not load the People folder.");
    expect(html.match(/>Try again<\/button>/g)).toHaveLength(3);
    expect(html).not.toContain("Nothing to review");
    expect(html).not.toContain("No people yet");
  });

  it("separates connector oversight failure from no connectors", () => {
    const queryClient = client();
    fail(queryClient, queryKeys.settings.adminConnectorAccounts);
    const html = render(createElement(OversightPane), queryClient);
    expect(html).toContain("Could not load connectors.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No connectors");
  });

  it("does not show a successful zero count after an audit read fails", () => {
    const queryClient = client();
    fail(queryClient, queryKeys.settings.adminAuditEvents);
    const html = render(<AuditPane />, queryClient);
    expect(html).toContain("Could not load activity.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("0 of 0 events");
    expect(html).not.toContain("Admin and system actions appear here once recorded.");
  });
});

describe("core settings recovery and confirmation actions", () => {
  it("retries the failed Memory query through the real rendered retry control", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.memory.dashboard({}), { counts: {}, items: [] });
    fail(queryClient, queryKeys.memory.dashboard({ status: "pending" }));
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ counts: {}, items: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <FeedbackProvider>
            <MemoryDashboardPane />
          </FeedbackProvider>
        </QueryClientProvider>
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const retry = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Try again"));
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.props.onClick();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Nothing here.");
    act(() => renderer.unmount());
    queryClient.clear();
  });

  it("keeps broken-key replacement behind an authored Cancel-first confirmation", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.ai.familyKeys, {
      keys: [{ family: "integrations", source: "broken", cause: "store" }]
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <FeedbackProvider>
            <EncryptionKeysPane />
          </FeedbackProvider>
        </QueryClientProvider>
      );
    });
    const replace = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Replace key"));
    act(() => replace!.props.onClick());
    expect(rotateFamilyKey).not.toHaveBeenCalled();
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Anything locked under the old one stays unreadable."
    );
    const actions = dialog.findAllByType("button");
    expect(actions[0]!.children).toContain("Cancel");
    act(() => actions[0]!.props.onClick());
    expect(rotateFamilyKey).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => renderer.unmount());
    queryClient.clear();
  });

  it("keeps custom theme deletion behind the same authored confirmation", () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.settings.themes, {
      activeId: "light",
      mode: "light",
      builtIn: [],
      custom: [
        {
          id: "quiet-test",
          name: "Quiet test",
          builtIn: false,
          tokens: {
            paper: "#f2eee4",
            surface: "#faf8f1",
            surface2: "#efecdf",
            surface3: "#e8e4d6",
            ink: "#282c25",
            ink2: "#676c60",
            ink3: "#797e70",
            ink4: "#939886",
            line: "#c6cbbc",
            lineSubtle: "#dce0d2",
            lineStrong: "#9aa18d",
            accent: "#294b39"
          }
        }
      ]
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <FeedbackProvider>
            <AppearancePane />
          </FeedbackProvider>
        </QueryClientProvider>
      );
    });
    const remove = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Delete"));
    expect(remove).toBeDefined();
    act(() => remove!.props.onClick());
    expect(deleteCustomTheme).not.toHaveBeenCalled();
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(JSON.stringify(renderer.toJSON())).toContain("This can't be undone.");
    const cancel = dialog.findAllByType("button")[0]!;
    expect(cancel.children).toContain("Cancel");
    act(() => cancel.props.onClick());
    expect(deleteCustomTheme).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => renderer.unmount());
    queryClient.clear();
  });

  it("associates account-deletion fields without relaxing its confirmation factors", () => {
    const me: MeResponse = {
      user: {
        id: "fixture-member",
        email: "member@example.test",
        emailVerified: true,
        name: "Member",
        status: "active",
        isInstanceAdmin: false,
        isBootstrapOwner: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z"
      },
      profilePrefs: { addressed: null },
      hasPasswordCredential: true
    };
    const queryClient = client();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <FeedbackProvider>
            <DeleteAccount me={me} />
          </FeedbackProvider>
        </QueryClientProvider>
      );
    });
    const open = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Delete account"));
    act(() => open!.props.onClick());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    const labels = dialog.findAllByType("label");
    expect(labels).toHaveLength(3);
    const inputs = dialog.findAllByType("input");
    expect(inputs.map((input) => input.props.type)).toEqual(["email", "text", "password"]);
    for (const label of labels)
      expect(inputs.some((input) => input.props.id === label.props.htmlFor)).toBe(true);
    expect(
      dialog.findAllByType("button").find((button) => button.props.type === "submit")?.props
        .disabled
    ).toBe(true);
    act(() => renderer.unmount());
    queryClient.clear();
  });

  it("keeps module-owned Settings navigation on its existing destination", () => {
    const onNavigate = vi.fn();
    const onBack = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ModuleOwnPageLink
          moduleName="Finance"
          settingsPath="/finance/settings"
          onBack={onBack}
          onNavigate={onNavigate}
        />
      );
    });
    const open = renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Open Finance settings");
    expect(open?.props.className).toContain("jds-btn--link");
    act(() => open!.props.onClick());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("/finance/settings");
    expect(onBack).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe("settings Field consumer semantics", () => {
  it("names the mixed Location actions without replacing the search input label", () => {
    const me: MeResponse = {
      user: {
        id: "location-test",
        email: "member@example.test",
        emailVerified: true,
        name: "Member",
        status: "active",
        isInstanceAdmin: false,
        isBootstrapOwner: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z"
      },
      profilePrefs: { addressed: null },
      hasPasswordCredential: true
    };
    const html = render(<ProfilePane me={me} onNavigate={() => undefined} />, client());
    const labelId = /id="([^"]+)">Location<\/div>/.exec(html)?.[1];
    expect(labelId).toBeTruthy();
    expect(html).toContain(`role="group" aria-labelledby="${labelId}"`);
    expect(html.match(/aria-label="Search for a weather location"/g)).toHaveLength(1);
    expect(html).toContain("Use my location");
  });

  it("connects the OpenCode model label and hint directly to the select", () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.chat.settings, {
      chat: { responseStyle: "balanced", openCodeModel: "default" }
    });
    const html = render(<OpenCodeAcpCard cli={undefined} />, queryClient);
    const controlId = /<label[^>]*for="([^"]+)"[^>]*>Chat model<\/label>/.exec(html)?.[1];
    expect(controlId).toBeTruthy();
    expect(html).toContain(`id="${controlId}"`);
    expect(html).toContain(`aria-describedby="${controlId}-hint"`);
    expect(html).toContain(`id="${controlId}-hint"`);
    expect(html.match(/>Chat model<\/label>/g)).toHaveLength(1);
    expect(html).not.toContain('role="group"');
  });

  it("explicitly names the Skills action group without relabeling its buttons", () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.chat.skills, { skills: [] });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <FeedbackProvider>
            <SettingsSkillsPane />
          </FeedbackProvider>
        </QueryClientProvider>
      );
    });
    const createButton = renderer.root
      .findAllByType("button")
      .find((button) =>
        button.children.some((child) => typeof child === "string" && child.includes("Create skill"))
      );
    expect(createButton).toBeDefined();
    act(() => createButton!.props.onClick());
    const group = renderer.root.findByProps({ role: "group" });
    const groupLabel = renderer.root.findByProps({ id: group.props["aria-labelledby"] });
    expect(groupLabel.children).toContain("Save");
    const buttons = group.findAllByType("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.children).toContain("Create skill");
    expect(buttons[0]!.props.disabled).toBe(true);
    expect(buttons[1]!.children).toContain("Cancel");
    act(() => renderer.unmount());
    queryClient.clear();
  });
});
