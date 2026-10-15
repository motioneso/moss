import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Segmented } from "@moss/ui";
import type { ConnectorAccountDto, IntegrationSummary, MeResponse } from "@moss/shared";
import type { ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { AuthScreen } from "../../apps/web/src/auth/auth-screen.js";
import { WelcomeStep } from "../../apps/web/src/onboarding/welcome-step.js";
import {
  FinishStep,
  getMemberConnectionStatus
} from "../../apps/web/src/onboarding/onboarding-wizard.js";
import { GoogleConnectorStep } from "../../apps/web/src/onboarding/google-connector-step.js";
import { AssistantPane } from "../../apps/web/src/settings/settings-ai-pane.js";
import { PeoplePane } from "../../apps/web/src/settings/settings-admin-panes.js";
import { GoogleConnect } from "../../apps/web/src/settings/settings-google-connect.js";
import { SettingsIntegrationsPane } from "../../apps/web/src/settings/settings-integrations-pane.js";
import { SettingsPage } from "../../apps/web/src/settings/settings-page.js";

vi.mock("../../apps/web/src/settings/settings-feedback.js", () => ({
  useFeedback: () => ({ toast: vi.fn(), confirm: vi.fn() }),
  FeedbackProvider: ({ children }: { children: ReactNode }) => children
}));

vi.mock("../../apps/web/src/connectors/use-google-connect-flow.js", () => ({
  GOOGLE_CONNECT_SUCCESS_QUERY_KEYS: [],
  useGoogleConnectFlow: () => googleFlow
}));

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Fern",
  assistantName: () => "Fern",
  personalize: (text: string) => text.replaceAll("Moss", "Fern"),
  personalizeMarkdown: (text: string) => text.replaceAll("Moss", "Fern"),
  holdAssistantNameForSignIn: vi.fn(),
  loadPersonaSettings: vi.fn()
}));

const flowDefaults = {
  clientId: "",
  clientSecret: "",
  authUrl: null as string | null,
  redirectUrl: "",
  completionPending: false,
  authorizationPending: false,
  popupBlocked: false,
  error: null,
  setClientId: vi.fn(),
  setClientSecret: vi.fn(),
  setRedirectUrl: vi.fn(),
  openConsentScreen: vi.fn(),
  finishConnection: vi.fn()
};
let googleFlow = { ...flowDefaults };
let renderer: ReactTestRenderer | undefined;

const me: MeResponse = {
  user: {
    id: "admin-1",
    email: "admin@example.test",
    emailVerified: true,
    name: "Admin",
    status: "active",
    isInstanceAdmin: true,
    isBootstrapOwner: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
  });
}

function wrap(node: ReactNode, queryClient = client(), path = "/settings"): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

function account(overrides: Partial<ConnectorAccountDto> = {}): ConnectorAccountDto {
  return {
    id: "google-1",
    providerId: "google",
    providerType: "google",
    providerDisplayName: "Google",
    providerStatus: "available",
    ownerUserId: "member-1",
    scopes: [],
    status: "active",
    hasSecret: true,
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSyncStartedAt: null,
    lastSyncFinishedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastSyncCounts: null,
    ...overrides
  };
}

function failList(queryClient: QueryClient): void {
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: queryKeys.integrations.list })
    .setState({
      status: "error",
      error: new Error("Unavailable")
    });
}

beforeEach(() => {
  googleFlow = { ...flowDefaults };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("setup truthfulness audit", () => {
  it("reserves the owner signup title for bootstrap and uses the ordinary account title otherwise", async () => {
    expect(
      renderToString(wrap(<AuthScreen needsBootstrap onAuthenticated={async () => undefined} />))
    ).toContain("Create owner account");
    await act(async () => {
      renderer = create(
        wrap(<AuthScreen needsBootstrap={false} onAuthenticated={async () => undefined} />)
      );
    });
    await act(async () => renderer!.root.findByType(Segmented).props.onChange("sign-up"));
    expect(renderer!.root.findByProps({ id: "auth-title" }).children).toEqual(["Create account"]);
  });

  it("describes the two current owner setup steps in their existing composition", () => {
    const html = renderToString(<WelcomeStep onSkipAll={() => undefined} />);
    expect(html).toContain("Choose an AI provider");
    expect(html).toContain("finish setup later in Settings");
    expect(html.match(/class="onb-ahead__row"/g)).toHaveLength(2);
    expect(html).toContain('class="onb-ahead__n">01');
    expect(html).toContain('class="onb-ahead__n">02');
    expect(html).not.toContain("Control channel");
    expect(html).not.toContain("connection to your computer");
  });

  it.each([
    [[], "Not connected"],
    [[account()], "Google connected"],
    [[account({ providerType: "imap" })], "Email connected"],
    [[account({ status: "revoked" })], "Not connected"],
    [[account({ status: "error" })], "Connection needs attention"]
  ] as const)("reports saved accounts truthfully: %j", (accounts, expected) => {
    const html = renderToString(
      <FinishStep
        role="member"
        skippedSteps={new Set(["accounts"])}
        memberConnection={getMemberConnectionStatus(accounts, false)}
        pending={false}
        onFinish={() => undefined}
      />
    );
    expect(html).toContain(expected);
    expect(html).toContain("Review your setup, then choose Finish setup.");
    expect(html).not.toContain("Setup complete");
    expect(html).not.toContain("Google integration");
    expect(html).not.toContain("private");
  });

  it("keeps unknown account reads distinct from saved empty accounts", () => {
    expect(getMemberConnectionStatus(undefined, false)).toBe("pending");
    expect(getMemberConnectionStatus(undefined, true)).toBe("error");
    const html = renderToString(
      <FinishStep
        role="member"
        skippedSteps={new Set()}
        memberConnection={getMemberConnectionStatus([account()], true)}
        pending={false}
        onFinish={() => undefined}
      />
    );
    expect(html).toContain("Couldn’t check connections");
    expect(html).not.toContain("Google connected");
  });

  it("gives a concrete OAuth setup instruction on both Google flows", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.connectors.accounts, { accounts: [] });
    queryClient.setQueryData(queryKeys.settings.persona, {});
    await act(async () => {
      renderer = create(
        wrap(
          <GoogleConnectorStep
            eyebrow="Google"
            title="Connect Google"
            lede="Connect"
            privacy="Private"
          />,
          queryClient
        )
      );
    });
    await act(async () =>
      renderer!.root.findAllByProps({ className: "onb-prov" })[0]!.props.onClick()
    );
    const onboardingText = JSON.stringify(renderer!.toJSON());
    const settingsText = renderToString(<GoogleConnect onBack={() => undefined} />);
    for (const text of [onboardingText, settingsText]) {
      expect(text).toContain(
        "Create a Google OAuth app, then paste its client ID and secret here."
      );
      expect(text).not.toContain("never pass through");
    }
  });

  it.each([
    [{}, "Authorize Google, then paste the redirect address."],
    [
      {
        clientId: "client-id-long",
        clientSecret: "secret-long",
        authUrl: "https://example.test/consent",
        redirectUrl: "http://localhost:1/?code=accepted"
      },
      "Ready to connect."
    ],
    [{ completionPending: true }, "Connecting Google…"]
  ])(
    "reports the Google exchange state without implying work has started: %j",
    (overrides, expected) => {
      googleFlow = { ...flowDefaults, ...overrides };
      const html = renderToString(<GoogleConnect onBack={() => undefined} />);
      expect(html).toContain(expected);
      expect(html).not.toContain("Looks good — completing");
      if (googleFlow.completionPending) expect(html).not.toContain("Ready to connect.");
    }
  );

  it("names the actual AI provider settings destination", () => {
    const html = renderToString(
      wrap(<AssistantPane me={me} onNavigate={() => undefined} onSelectSection={() => undefined} />)
    );
    expect(html).toContain("Admin / Setup → AI providers");
    expect(html).not.toContain("Admin → Assistant");
  });

  it("describes delegated admin access without calling it owner access", () => {
    const html = renderToString(
      wrap(<SettingsPage me={me} />, client(), "/settings?section=people")
    );
    expect(html).toContain("You have admin access");
    expect(html).not.toContain("You have owner access");
  });

  it.each([true, false])(
    "ties the members description to requiresApproval=%s",
    (requiresApproval) => {
      const queryClient = client();
      queryClient.setQueryData(queryKeys.settings.registrationSettings, {
        registrationEnabled: true,
        requiresApproval
      });
      queryClient.setQueryData(queryKeys.settings.adminUsers, { users: [] });
      const html = renderToString(
        wrap(<PeoplePane me={me} onNavigate={() => undefined} />, queryClient)
      );
      expect(html).toContain("New accounts appear here.");
      expect(html.includes("New sign-ups wait here for approval.")).toBe(requiresApproval);
    }
  );

  it("shows loading until the integration list has been read", () => {
    const html = renderToString(wrap(<SettingsIntegrationsPane />));
    expect(html).toContain("Loading connections…");
    expect(html).not.toContain("No connections yet.");
  });

  it("shows a retryable integration error without claiming the list is empty", () => {
    const queryClient = client();
    failList(queryClient);
    const html = renderToString(wrap(<SettingsIntegrationsPane />, queryClient));
    expect(html).toContain("Couldn’t load connections. Try again.");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("No connections yet.");
    expect(html).not.toContain("Loading connections…");
  });

  it("retains saved integration rows when a refresh fails", () => {
    const queryClient = client();
    const integration: IntegrationSummary = {
      id: "connection-1",
      name: "Saved service",
      kind: "mcp",
      url: "https://example.test",
      enabled: true,
      hasCredential: true,
      toolCount: 1,
      enabledToolCount: 1,
      lastDiscoveryAt: null,
      lastError: null
    };
    queryClient.setQueryData(queryKeys.integrations.list, { integrations: [integration] });
    failList(queryClient);
    const html = renderToString(wrap(<SettingsIntegrationsPane />, queryClient));
    expect(html).toContain("Saved service");
    expect(html).toContain("Couldn’t load connections. Try again.");
    expect(html).not.toContain("No connections yet.");
  });

  it("shows the empty message only after a successful empty integration read", () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.integrations.list, { integrations: [] });
    const html = renderToString(wrap(<SettingsIntegrationsPane />, queryClient));
    expect(html).toContain("No connections yet.");
    expect(html).not.toContain("Loading connections…");
    expect(html).not.toContain("Couldn’t load connections");
  });
});
