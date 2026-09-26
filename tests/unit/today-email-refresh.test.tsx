import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailRefreshStatusResponse, SourceFreshnessV1 } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { getBriefingRun, requestJson } from "../../apps/web/src/api/client.js";
import {
  emailRefreshAllowsBriefing,
  isEmailSourceStale,
  TodayEmailRefreshAction
} from "../../apps/web/src/today/today-email-refresh.js";

vi.mock("../../apps/web/src/api/client.js", () => ({
  getBriefingRun: vi.fn(),
  requestJson: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFINITION_ID = "briefing-morning";
const REFRESH_ID = "5ca70123-f234-4e56-bfab-9bf8c3e28fc3";
const RUN_ID = "6d24e399-40c0-4e9a-90a9-fc0d434795f7";
const REFRESH_ENDPOINT = "/api/connectors/email-refresh";
const STATUS_ENDPOINT = `${REFRESH_ENDPOINT}/${REFRESH_ID}`;
const RUN_ENDPOINT = `/api/briefings/definitions/${DEFINITION_ID}/run`;
const CAPTURED_AT = "2026-09-25T12:00:00.000Z";

const staleFreshness: SourceFreshnessV1 = {
  version: 1,
  capturedAt: CAPTURED_AT,
  sources: [
    {
      source: "email",
      freshnessKind: "connector_sync",
      asOf: "2026-09-24T10:59:59.999Z"
    }
  ]
};

const freshFreshness: SourceFreshnessV1 = {
  ...staleFreshness,
  sources: [{ ...staleFreshness.sources[0]!, asOf: "2026-09-24T12:00:00.000Z" }]
};

let currentRefreshStatus: EmailRefreshStatusResponse["status"];
let renderer: ReactTestRenderer | undefined;
let queryClient: QueryClient | undefined;

beforeEach(() => {
  currentRefreshStatus = "running";
  vi.mocked(requestJson).mockImplementation(async (path, options) => {
    if (path === REFRESH_ENDPOINT && options?.method === "POST") {
      return { refreshId: REFRESH_ID, enqueued: true, deduped: false } as never;
    }
    if (path === STATUS_ENDPOINT) {
      return {
        refreshId: REFRESH_ID,
        status: currentRefreshStatus,
        createdAt: CAPTURED_AT,
        startedAt: currentRefreshStatus === "queued" ? null : CAPTURED_AT,
        completedAt:
          currentRefreshStatus === "succeeded" ||
          currentRefreshStatus === "partial" ||
          currentRefreshStatus === "failed"
            ? CAPTURED_AT
            : null,
        accounts: [],
        errorCode: currentRefreshStatus === "failed" ? "email-error" : null
      } satisfies EmailRefreshStatusResponse as never;
    }
    if (path === RUN_ENDPOINT && options?.method === "POST") {
      return { jobId: "briefing-job", runId: RUN_ID } as never;
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.mocked(getBriefingRun).mockResolvedValue({
    state: "pending",
    run: null,
    latest: false,
    plan: null
  });
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  queryClient?.clear();
  queryClient = undefined;
  vi.clearAllMocks();
});

describe("TodayEmailRefreshAction", () => {
  it("offers the action only when the email source is over a day old", () => {
    expect(isEmailSourceStale(staleFreshness)).toBe(true);
    expect(isEmailSourceStale(freshFreshness)).toBe(false);
    expect(
      isEmailSourceStale({
        ...staleFreshness,
        sources: [{ ...staleFreshness.sources[0]!, freshnessKind: "realtime" }]
      })
    ).toBe(false);

    expect(
      renderToString(
        createElement(TodayEmailRefreshAction, {
          definitionId: DEFINITION_ID,
          freshness: freshFreshness
        })
      )
    ).toBe("");
  });

  it("waits for terminal email success before starting one briefing with the refresh ID", async () => {
    const mounted = mountAction();
    const button = mounted.root.findByType("button");

    await act(async () => {
      button.props.onClick();
      await tick();
    });
    await settle();

    expect(vi.mocked(requestJson).mock.calls.some(([path]) => path === STATUS_ENDPOINT)).toBe(true);
    expect(vi.mocked(requestJson).mock.calls.some(([path]) => path === RUN_ENDPOINT)).toBe(false);
    expect(findStatusText(mounted.root)).toContain("Refreshing email");

    currentRefreshStatus = "succeeded";
    await act(async () => {
      queryClient?.setQueryData(["connectors", "email-refresh", REFRESH_ID], {
        refreshId: REFRESH_ID,
        status: "succeeded",
        createdAt: CAPTURED_AT,
        startedAt: CAPTURED_AT,
        completedAt: CAPTURED_AT,
        accounts: [],
        errorCode: null
      } satisfies EmailRefreshStatusResponse);
      await tick();
    });
    await settle();

    const runRequest = vi.mocked(requestJson).mock.calls.find(([path]) => path === RUN_ENDPOINT);
    expect(runRequest?.[1]).toMatchObject({
      method: "POST",
      body: { idempotencyKey: REFRESH_ID }
    });
    expect(
      vi.mocked(requestJson).mock.calls.filter(([path]) => path === RUN_ENDPOINT)
    ).toHaveLength(1);
    expect(getBriefingRun).toHaveBeenCalledWith(DEFINITION_ID, RUN_ID);

    await act(async () => {
      queryClient?.setQueryData(queryKeys.briefings.runs(DEFINITION_ID), { runs: [] });
      queryClient?.setQueryData(queryKeys.briefings.run(DEFINITION_ID, RUN_ID), {
        state: "ready",
        run: { status: "succeeded" },
        latest: true,
        plan: null
      });
      await tick();
    });
    expect(queryClient?.getQueryState(queryKeys.briefings.runs(DEFINITION_ID))?.isInvalidated).toBe(
      true
    );
  });

  it("keeps the current report and plan choices when refresh fails", async () => {
    currentRefreshStatus = "failed";
    const mounted = mountAction();
    const button = mounted.root.findByType("button");

    await act(async () => {
      button.props.onClick();
      await tick();
    });
    await settle();

    expect(findStatusText(mounted.root)).toContain(
      "Your current report and plan choices are still available."
    );
    expect(vi.mocked(requestJson).mock.calls.some(([path]) => path === RUN_ENDPOINT)).toBe(false);
    expect(vi.mocked(getBriefingRun)).not.toHaveBeenCalled();
    expect(
      mounted.root
        .findAllByType("button")
        .find((candidate) => textOf(candidate) === "Refresh email")
    ).toBeDefined();
  });

  it("allows a retry when briefing status lookup fails before returning data", async () => {
    vi.mocked(getBriefingRun).mockRejectedValue(new Error("network"));
    const mounted = mountAction();

    await act(async () => {
      mounted.root.findByType("button").props.onClick();
      await tick();
    });
    await settle();

    currentRefreshStatus = "succeeded";
    await act(async () => {
      queryClient?.setQueryData(["connectors", "email-refresh", REFRESH_ID], {
        refreshId: REFRESH_ID,
        status: "succeeded",
        createdAt: CAPTURED_AT,
        startedAt: CAPTURED_AT,
        completedAt: CAPTURED_AT,
        accounts: [],
        errorCode: null
      } satisfies EmailRefreshStatusResponse);
      await tick();
    });
    await settle();

    expect(getBriefingRun).toHaveBeenCalledWith(DEFINITION_ID, RUN_ID);
    expect(findStatusText(mounted.root)).toContain(
      "couldn’t prepare an updated briefing. Your current report and plan choices are still available."
    );
    expect(mounted.root.findByType("button").props.disabled).toBe(false);
  });

  it("reuses the request idempotency key after an uncertain POST failure", async () => {
    const requestKeys: string[] = [];
    vi.mocked(requestJson).mockImplementation(async (path, options) => {
      if (path === REFRESH_ENDPOINT && options?.method === "POST") {
        const body = options.body as { readonly idempotencyKey: string };
        requestKeys.push(body.idempotencyKey);
        if (requestKeys.length === 1) throw new Error("connection closed before response");
        return { refreshId: REFRESH_ID, enqueued: true, deduped: true } as never;
      }
      if (path === STATUS_ENDPOINT) {
        return {
          refreshId: REFRESH_ID,
          status: "running",
          createdAt: CAPTURED_AT,
          startedAt: CAPTURED_AT,
          completedAt: null,
          accounts: [],
          errorCode: null
        } as never;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const mounted = mountAction();

    await act(async () => {
      mounted.root.findByType("button").props.onClick();
      await tick();
    });
    await settle();
    expect(findStatusText(mounted.root)).toContain("couldn’t start an email refresh");

    await act(async () => {
      mounted.root.findByType("button").props.onClick();
      await tick();
    });
    await settle();

    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(requestKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(vi.mocked(requestJson).mock.calls.some(([path]) => path === STATUS_ENDPOINT)).toBe(true);
  });

  it("allows a briefing only after succeeded or partial status", () => {
    expect(emailRefreshAllowsBriefing("succeeded")).toBe(true);
    expect(emailRefreshAllowsBriefing("partial")).toBe(true);
    expect(emailRefreshAllowsBriefing("queued")).toBe(false);
    expect(emailRefreshAllowsBriefing("running")).toBe(false);
    expect(emailRefreshAllowsBriefing("failed")).toBe(false);
    expect(emailRefreshAllowsBriefing(undefined)).toBe(false);
  });
});

function mountAction(): { readonly root: ReactTestInstance } {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  act(() => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client: queryClient! },
        createElement(TodayEmailRefreshAction, {
          definitionId: DEFINITION_ID,
          freshness: staleFreshness
        })
      )
    );
  });
  if (!renderer) throw new Error("Today email refresh action did not render");
  return { root: renderer.root };
}

function findStatusText(root: ReactTestInstance): string {
  const status = root.findByProps({ role: "status" });
  return textOf(status);
}

function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: ReactTestInstance | string): void => {
    if (typeof child === "string") {
      parts.push(child);
      return;
    }
    for (const grandchild of child.children) walk(grandchild);
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function settle(): Promise<void> {
  await act(async () => {
    await tick();
    await tick();
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
