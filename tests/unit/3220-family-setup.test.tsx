import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiKeyOptOutStep } from "../../apps/web/src/onboarding/api-key-opt-out-step.js";
import { useChatAvailable } from "../../apps/web/src/onboarding/chat-availability.js";
import {
  createAiProvider,
  getAiSummary,
  lookupAiCapabilityRoute
} from "../../apps/web/src/api/client.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAiProvider: vi.fn(),
  getAiSummary: vi.fn(),
  lookupAiCapabilityRoute: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.resetAllMocks();
});

async function mount(node: () => ReturnType<typeof createElement>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client }, node()));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("#3220 WEB-15 reply availability for members", () => {
  it("reports chat available whenever the chat route is usable, whatever the role", async () => {
    vi.mocked(lookupAiCapabilityRoute).mockResolvedValue({
      route: { available: true }
    } as never);
    let seen: boolean | undefined;
    function Probe() {
      seen = useChatAvailable();
      return null;
    }
    await mount(() => createElement(Probe));
    expect(seen).toBe(true);
  });
});

describe("#3220 WEB-14 member personal key", () => {
  it("saves the typed key as a personal provider", async () => {
    vi.mocked(getAiSummary).mockResolvedValue({
      summary: { hasPersonalAiProvider: false }
    } as never);
    vi.mocked(createAiProvider).mockResolvedValue({} as never);
    await mount(() => createElement(ApiKeyOptOutStep, { onSkipStep: () => undefined }));

    const personal = renderer!.root.find((n) => n.props?.name === "Add a personal key");
    await act(async () => personal.props.onClick());

    const input = renderer!.root.findByProps({ id: "member-personal-ai-key" });
    expect(input.props.type).toBe("password");
    await act(async () => input.props.onChange({ target: { value: "sk-test-123" } }));

    const save = renderer!.root
      .findAll((n) => n.props?.["data-testid"] === "member-personal-ai-key-save")
      .find((n) => typeof n.props.onClick === "function")!;
    await act(async () => save.props.onClick());

    expect(createAiProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        authMethod: "api_key",
        credentialPayload: { apiKey: "sk-test-123" }
      })
    );
  });
});
