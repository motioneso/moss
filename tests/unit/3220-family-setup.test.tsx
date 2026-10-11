import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiKeyOptOutStep } from "../../apps/web/src/onboarding/api-key-opt-out-step.js";
import { getAiSummary } from "../../apps/web/src/api/client.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAiSummary: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.resetAllMocks();
});

describe("#3220 WEB-14 member setup step", () => {
  it("offers no key field and skips on the shared setup", async () => {
    vi.mocked(getAiSummary).mockResolvedValue({
      summary: { hasPersonalAiProvider: false }
    } as never);
    const onSkipStep = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ApiKeyOptOutStep, { onSkipStep })
        )
      );
    });

    expect(renderer!.root.findAllByType("input")).toHaveLength(0);
    const names = renderer!.root.findAll((n) => typeof n.props?.name === "string");
    expect(names.map((n) => n.props.name)).toEqual(["Use the shared setup"]);
    expect(renderer!.root.findAll((n) => n.props?.id === "member-personal-ai-key")).toHaveLength(0);

    const shared = names[0]!;
    await act(async () => shared.props.onClick());
    expect(onSkipStep).toHaveBeenCalledTimes(1);
  });
});
