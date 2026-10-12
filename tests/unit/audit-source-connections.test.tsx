// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as apiClient from "../../apps/web/src/api/client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ConnectionsPane } from "../../apps/web/src/settings/settings-connections-pane.js";

vi.mock("../../apps/web/src/settings/settings-integrations-pane.js", () => ({
  SettingsIntegrationsPane: () => null
}));
vi.mock("../../apps/web/src/settings/settings-feedback.js", () => ({
  useFeedback: () => ({ toast: vi.fn(), confirm: vi.fn() })
}));
vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss",
  personalize: (text: string) => text
}));
vi.mock("../../apps/web/src/shell/chat-controls-context.js", () => ({
  useChatControls: () => ({ pendingNotesDelete: null })
}));

const mocks = vi.hoisted(() => ({ getNotesSource: vi.fn() }));
vi.mock("../../apps/web/src/api/notes-client.js", () => ({
  getNotesSource: mocks.getNotesSource,
  getNotesLastSync: () => Promise.resolve({ lastSync: null }),
  putNotesSource: vi.fn(),
  postNotesSync: vi.fn()
}));
vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof apiClient>()),
  listConnectorAccounts: () => Promise.resolve({ accounts: [] }),
  listIntegrations: () => Promise.resolve({ integrations: [] })
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const renderers: ReactTestRenderer[] = [];
const clients: QueryClient[] = [];

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function renderConnections(path: string | null | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  if (path !== undefined) client.setQueryData(queryKeys.settings.notesSource, { path });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConnectionsPane />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  renderers.push(renderer);
  await settle();
  return renderer;
}
function summaryOf(renderer: ReactTestRenderer) {
  return textOf(renderer.root.findByProps({ "aria-label": "Connections at a glance" }));
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
  clients.splice(0).forEach((client) => client.clear());
});

describe("CORE01 Connections source summary truth", () => {
  it.each(["/synthetic/previous", null, undefined])(
    "reports unknown after a mounted failed source read even with cached path %s",
    async (path) => {
      mocks.getNotesSource.mockRejectedValue(new Error("Synthetic read failure"));
      const renderer = await renderConnections(path);
      const summary = summaryOf(renderer);
      expect(summary).toContain("Unknown");
      expect(summary).not.toContain("Linked");
      expect(summary).not.toContain("None");
      if (path) expect(textOf(renderer.root)).toContain(path);
    }
  );

  it("keeps a cold pending read unknown, then updates the shared summary after retry", async () => {
    let reject!: (error: Error) => void;
    mocks.getNotesSource.mockReturnValue(
      new Promise((_, no) => {
        reject = no;
      })
    );
    const renderer = await renderConnections(undefined);
    expect(summaryOf(renderer)).not.toContain("None");
    expect(summaryOf(renderer)).not.toContain("Linked");
    expect(textOf(renderer.root)).toContain("Checking linked folder");
    await act(async () => reject(new Error("Synthetic outage")));
    await settle();
    expect(summaryOf(renderer)).toContain("Unknown");
    mocks.getNotesSource.mockResolvedValue({ path: null });
    await act(async () => {
      renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Try again")
        .props.onClick();
    });
    await settle();
    expect(summaryOf(renderer)).toContain("None");
    expect(summaryOf(renderer)).not.toContain("Unknown");
  });
});
