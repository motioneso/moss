// @vitest-environment jsdom
// Connection page state (#2984 R2.5): overlapping tool changes keep every click, and an open
// page picks up a finished sort without a reload.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IntegrationClassifierRisk,
  IntegrationClassifierToolSort,
  IntegrationDetail,
  UpdateIntegrationRequest
} from "@moss/shared";

const api = vi.hoisted(() => ({
  getIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  setIntegrationSendWithoutAsking: vi.fn(),
  setIntegrationKeptOut: vi.fn(),
  prepareIntegrationClassifierTools: vi.fn(),
  sortIntegrationClassifierTools: vi.fn()
}));

vi.mock("../../apps/web/src/api/client.js", () => api);

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import {
  SORT_POLL_MS,
  SORT_WATCH_MS,
  useIntegrationDetail
} from "../../apps/web/src/settings/integration-detail-state.js";

type Deferred = { resolve: (value: unknown) => void };

function sorted(
  toolName: string,
  risk: IntegrationClassifierRisk | null,
  status: IntegrationClassifierToolSort["status"] = "current"
): IntegrationClassifierToolSort {
  return {
    toolName,
    status,
    risk: status === "current" ? risk : null,
    failure: null,
    sendWithoutAsking: false,
    asksFirst: status !== "current" || risk === "outbound" || risk === "destructive",
    readableName: toolName,
    sortedAt: status === "current" ? "2026-10-02T09:00:00.000Z" : null,
    sortedBy: null,
    sortMethod: null,
    failedAt: null,
    keptOut: false,
    classifierState: "off",
    preparationFailure: null,
    preparedAt: null
  };
}

function detail(overrides: Partial<IntegrationDetail> = {}): IntegrationDetail {
  return {
    id: "conn-1",
    name: "Hub",
    kind: "mcp",
    url: "http://hub.test/mcp",
    enabled: true,
    hasCredential: false,
    toolCount: 4,
    enabledToolCount: 4,
    lastDiscoveryAt: null,
    lastError: null,
    credentialPlacement: null,
    tools: ["read_a", "read_b", "send_a", "send_b"].map((name) => ({
      name,
      description: "",
      group: "",
      inputSchema: null
    })),
    groups: [],
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    groupOptIn: false,
    specPasted: false,
    classifierEnabled: false,
    classifierTools: [
      sorted("read_a", "read"),
      sorted("read_b", "read"),
      sorted("send_a", "outbound"),
      sorted("send_b", "outbound")
    ],
    ...overrides
  };
}

let state: ReturnType<typeof useIntegrationDetail> | undefined;
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
const onError = vi.fn();

function Harness() {
  state = useIntegrationDetail("conn-1", onError);
  return null;
}

async function mount(): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client }, createElement(Harness)));
  });
  await act(async () => {
    await vi.waitFor(() => expect(state?.detailQuery.data).toBeDefined());
  });
}

function shown(): IntegrationDetail {
  return state!.detailQuery.data!;
}

beforeEach(() => {
  api.getIntegration.mockReset();
  api.updateIntegration.mockReset();
  api.setIntegrationSendWithoutAsking.mockReset();
  api.setIntegrationKeptOut.mockReset();
  api.prepareIntegrationClassifierTools.mockReset();
  api.sortIntegrationClassifierTools.mockReset();
  onError.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  state = undefined;
  client?.clear();
  vi.useRealTimers();
});

describe("useIntegrationDetail overlapping changes", () => {
  it("keeps both groups off when a second group is turned off before the first answer", async () => {
    // The server stores what each request sends, the way its replace-the-lists update does.
    let stored = detail();
    api.getIntegration.mockImplementation(async () => stored);
    const answers: Deferred[] = [];
    api.updateIntegration.mockImplementation(
      (_id: string, body: UpdateIntegrationRequest) =>
        new Promise((resolve) => {
          answers.push({
            resolve: () => {
              stored = { ...stored, ...body } as IntegrationDetail;
              resolve(stored);
            }
          });
        })
    );
    await mount();

    act(() => state!.setToolsOn(["send_a", "send_b"], false));
    act(() => state!.setToolsOn(["read_a", "read_b"], false));
    expect(shown().mutedTools).toEqual(["send_a", "send_b", "read_a", "read_b"]);

    await act(async () => {
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      answers[0]!.resolve(undefined);
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]!.resolve(undefined);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api.getIntegration).toHaveBeenCalledTimes(2));
    });

    expect(api.updateIntegration.mock.calls.map(([, body]) => body.mutedTools)).toEqual([
      ["send_a", "send_b"],
      ["send_a", "send_b", "read_a", "read_b"]
    ]);
    expect(stored.mutedTools).toEqual(["send_a", "send_b", "read_a", "read_b"]);
    expect(shown().mutedTools).toEqual(["send_a", "send_b", "read_a", "read_b"]);
  });

  it("sends allow and ask for one tool in click order, so the newer click wins", async () => {
    let stored = detail();
    api.getIntegration.mockImplementation(async () => stored);
    const answers: Deferred[] = [];
    api.setIntegrationSendWithoutAsking.mockImplementation(
      (_id: string, body: { allow: boolean; toolNames: string[] }) =>
        new Promise((resolve) => {
          answers.push({
            resolve: () => {
              stored = {
                ...stored,
                classifierTools: stored.classifierTools.map((tool) =>
                  body.toolNames.includes(tool.toolName)
                    ? { ...tool, sendWithoutAsking: body.allow, asksFirst: !body.allow }
                    : tool
                )
              };
              resolve(stored);
            }
          });
        })
    );
    await mount();

    act(() => state!.setSendWithoutAsking(["send_a", "send_b"], true));
    act(() => state!.setSendWithoutAsking(["send_a"], false));
    const sendA = () => shown().classifierTools.find((tool) => tool.toolName === "send_a")!;
    expect(sendA()).toMatchObject({ sendWithoutAsking: false, asksFirst: true });

    await act(async () => {
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      // Only one request is out at a time, so the first answer cannot land after the second.
      expect(api.setIntegrationSendWithoutAsking).toHaveBeenCalledTimes(1);
      answers[0]!.resolve(undefined);
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]!.resolve(undefined);
    });
    await act(async () => {
      await vi.waitFor(() => expect(api.getIntegration).toHaveBeenCalledTimes(2));
    });

    expect(sendA()).toMatchObject({ sendWithoutAsking: false, asksFirst: true });
    expect(shown().classifierTools.find((tool) => tool.toolName === "send_b")).toMatchObject({
      sendWithoutAsking: true
    });
  });
});

describe("useIntegrationDetail sorting", () => {
  it("picks up a finished sort on the open page, then stops re-reading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const waiting = detail({
      classifierTools: [
        sorted("read_a", null, "never_tried"),
        sorted("read_b", null, "never_tried"),
        sorted("send_a", null, "never_tried"),
        sorted("send_b", null, "never_tried")
      ]
    });
    let stored = waiting;
    api.getIntegration.mockImplementation(async () => stored);
    await mount();
    expect(shown().classifierTools.every((tool) => tool.status === "never_tried")).toBe(true);

    stored = detail();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(shown().classifierTools.every((tool) => tool.status === "current")).toBe(true)
      );
    });

    const reads = api.getIntegration.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS * 3);
    });
    expect(api.getIntegration).toHaveBeenCalledTimes(reads);
  });
});

describe("useIntegrationDetail classifier (#2984 R2.5b)", () => {
  const keptOut = (name: string) =>
    shown().classifierTools.find((tool) => tool.toolName === name)!.keptOut;

  it("keeps a tool out, then Undo lets it back in, in click order", async () => {
    let stored = detail();
    api.getIntegration.mockImplementation(async () => stored);
    api.setIntegrationKeptOut.mockImplementation(
      async (_id: string, body: { keptOut: boolean; toolNames: string[] }) => {
        stored = {
          ...stored,
          classifierTools: stored.classifierTools.map((tool) =>
            body.toolNames.includes(tool.toolName) ? { ...tool, keptOut: body.keptOut } : tool
          )
        };
        return stored;
      }
    );
    await mount();

    act(() => state!.setKeptOut(["send_a"], true));
    expect(keptOut("send_a")).toBe(true);
    act(() => state!.setKeptOut(["send_a"], false));
    expect(keptOut("send_a")).toBe(false);

    await act(async () => {
      await vi.waitFor(() => expect(api.getIntegration).toHaveBeenCalledTimes(2));
    });
    expect(api.setIntegrationKeptOut.mock.calls.map((call) => call[1])).toEqual([
      { keptOut: true, toolNames: ["send_a"] },
      { keptOut: false, toolNames: ["send_a"] }
    ]);
    expect(keptOut("send_a")).toBe(false);
  });

  it("rolls a refused keep-out back to what the server holds, and reports it", async () => {
    const stored = detail();
    api.getIntegration.mockImplementation(async () => stored);
    api.setIntegrationKeptOut.mockRejectedValue(new Error("refused"));
    await mount();

    act(() => state!.setKeptOut(["read_a"], true));
    expect(keptOut("read_a")).toBe(true);
    await act(async () => {
      await vi.waitFor(() => expect(api.getIntegration).toHaveBeenCalledTimes(2));
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(keptOut("read_a")).toBe(false);
  });

  it("turns the classifier on through the connection, and Try again asks for preparation and sorting", async () => {
    const stored = detail();
    api.getIntegration.mockImplementation(async () => stored);
    api.updateIntegration.mockResolvedValue(stored);
    api.prepareIntegrationClassifierTools.mockResolvedValue({});
    api.sortIntegrationClassifierTools.mockResolvedValue({ status: "queued" });
    await mount();

    act(() => state!.setClassifierEnabled(true));
    expect(shown().classifierEnabled).toBe(true);
    act(() => state!.retryPreparation());
    act(() => state!.retrySort());
    await act(async () => {
      await vi.waitFor(() => expect(api.sortIntegrationClassifierTools).toHaveBeenCalledTimes(1));
    });

    expect(api.updateIntegration).toHaveBeenCalledWith("conn-1", { classifierEnabled: true });
    expect(api.prepareIntegrationClassifierTools).toHaveBeenCalledWith("conn-1", {});
    expect(api.sortIntegrationClassifierTools).toHaveBeenCalledWith("conn-1");
  });

  it("re-reads while tools are being prepared, then stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const prepared = (classifierState: IntegrationClassifierToolSort["classifierState"]) =>
      detail({
        classifierEnabled: true,
        classifierTools: detail().classifierTools.map((tool) => ({ ...tool, classifierState }))
      });
    let stored = prepared("preparing");
    api.getIntegration.mockImplementation(async () => stored);
    await mount();

    stored = prepared("ready");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(shown().classifierTools.every((tool) => tool.classifierState === "ready")).toBe(true)
      );
    });

    const reads = api.getIntegration.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS * 3);
    });
    expect(api.getIntegration).toHaveBeenCalledTimes(reads);
  });
});

describe("useIntegrationDetail Try again waits for the worker (#2984 R2.5b)", () => {
  const FAILED_AT = "2026-10-03T08:00:00.000Z";
  const tool = (name: string) => shown().classifierTools.find((entry) => entry.toolName === name)!;

  function withReadA(change: Partial<IntegrationClassifierToolSort>, enabled: boolean) {
    const base = detail({ classifierEnabled: enabled });
    return {
      ...base,
      classifierTools: base.classifierTools.map((entry) =>
        entry.toolName === "read_a"
          ? { ...entry, ...change }
          : enabled
            ? { ...entry, classifierState: "ready" as const }
            : entry
      )
    };
  }

  it("keeps re-reading after a preparation retry until the worker replaces the failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let stored = withReadA(
      { classifierState: "failed", preparationFailure: "provider_error", failedAt: FAILED_AT },
      true
    );
    api.getIntegration.mockImplementation(async () => stored);
    api.prepareIntegrationClassifierTools.mockResolvedValue({});
    await mount();
    expect(tool("read_a").classifierState).toBe("failed");

    // The request is accepted, and the read after it still holds the old failure.
    act(() => state!.retryPreparation());
    await act(async () => {
      await vi.waitFor(() => expect(api.getIntegration).toHaveBeenCalledTimes(2));
    });
    expect(tool("read_a").classifierState).toBe("preparing");
    expect(tool("read_a").preparationFailure).toBeNull();

    stored = withReadA({ classifierState: "ready" }, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS * 3);
    });
    expect(tool("read_a").classifierState).toBe("ready");

    const reads = api.getIntegration.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS * 3);
    });
    expect(api.getIntegration).toHaveBeenCalledTimes(reads);
  });

  it("keeps re-reading after a sort retry until the worker replaces the failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let stored = withReadA(
      { status: "failed", risk: null, failure: "error", sortedAt: null, failedAt: FAILED_AT },
      false
    );
    api.getIntegration.mockImplementation(async () => stored);
    api.sortIntegrationClassifierTools.mockResolvedValue({ status: "queued" });
    await mount();
    expect(tool("read_a").status).toBe("failed");

    // The request is accepted, and the read after it still holds the old failure.
    act(() => state!.retrySort());
    await act(async () => {
      await vi.waitFor(() => expect(api.getIntegration).toHaveBeenCalledTimes(2));
    });
    expect(tool("read_a").status).toBe("never_tried");
    expect(tool("read_a").failure).toBeNull();

    stored = withReadA({}, false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS * 3);
    });
    expect(tool("read_a").status).toBe("current");
    expect(tool("read_a").risk).toBe("read");
  });

  it("shows the failure again when the retry is refused", async () => {
    const stored = withReadA(
      { status: "failed", risk: null, failure: "error", sortedAt: null, failedAt: FAILED_AT },
      false
    );
    api.getIntegration.mockImplementation(async () => stored);
    api.sortIntegrationClassifierTools.mockRejectedValue(new Error("refused"));
    await mount();

    act(() => state!.retrySort());
    expect(tool("read_a").status).toBe("never_tried");
    await act(async () => {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    });
    await act(async () => {
      await vi.waitFor(() => expect(tool("read_a").status).toBe("failed"));
    });
  });
});

describe("useIntegrationDetail model settings (#2984 R2.5b)", () => {
  const tool = (name: string) => shown().classifierTools.find((entry) => entry.toolName === name)!;

  function withReadA(change: Partial<IntegrationClassifierToolSort>): IntegrationDetail {
    const base = detail({ classifierEnabled: true });
    return {
      ...base,
      classifierTools: base.classifierTools.map((entry) =>
        entry.toolName === "read_a"
          ? { ...entry, ...change }
          : { ...entry, classifierState: "ready" as const }
      )
    };
  }

  it("re-reads when the model settings change, then follows the resumed preparation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let stored = withReadA({
      classifierState: "failed",
      preparationFailure: "no_model",
      failedAt: "2026-10-03T08:00:00.000Z"
    });
    api.getIntegration.mockImplementation(async () => stored);
    await mount();
    expect(tool("read_a").preparationFailure).toBe("no_model");

    // The page has stopped watching by the time the owner adds a model elsewhere.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_WATCH_MS + SORT_POLL_MS);
    });
    const reads = api.getIntegration.mock.calls.length;
    await act(async () => {
      client.setQueryData(queryKeys.settings.providers, []);
      await client.invalidateQueries({ queryKey: queryKeys.settings.providers });
    });
    expect(api.getIntegration).toHaveBeenCalledTimes(reads);

    // The server now has a model and shows the tool preparing again.
    stored = withReadA({ classifierState: "preparing" });
    await act(async () => {
      client.setQueryData(queryKeys.ai.models, []);
      await client.invalidateQueries({ queryKey: queryKeys.ai.models });
    });
    await act(async () => {
      await vi.waitFor(() => expect(tool("read_a").classifierState).toBe("preparing"));
    });
    expect(tool("read_a").preparationFailure).toBeNull();

    stored = withReadA({ classifierState: "ready" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SORT_POLL_MS * 2);
    });
    expect(tool("read_a").classifierState).toBe("ready");
  });

  it("re-reads on reopening, even when the last read is still fresh", async () => {
    api.getIntegration.mockResolvedValue(detail());
    client = new QueryClient({
      defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 15_000 } }
    });
    const open = async () => {
      await act(async () => {
        renderer = create(createElement(QueryClientProvider, { client }, createElement(Harness)));
      });
      await act(async () => {
        await vi.waitFor(() => expect(state?.detailQuery.isFetching).toBe(false));
      });
    };
    await open();
    expect(api.getIntegration).toHaveBeenCalledTimes(1);
    act(() => renderer?.unmount());
    await open();
    expect(api.getIntegration).toHaveBeenCalledTimes(2);
  });
});
