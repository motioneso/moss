// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ApplyExecutionReport,
  DayPlanBlockDto,
  DayPlanDto,
  PreviewDayPlanResponse
} from "@moss/shared";

import {
  useDayPlanReview,
  type DayPlanReviewController
} from "../../apps/web/src/today/day-plan-review-controller.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TZ = "America/Los_Angeles";
const DAY = "2026-09-10";

function block(id: string, overrides: Partial<DayPlanBlockDto> = {}): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId: null,
    title: null,
    position: 0,
    actualPlacement: null,
    pendingChange: null,
    ...overrides
  };
}

function plan(): DayPlanDto {
  return {
    id: "plan-1",
    localDay: DAY,
    timeZone: TZ,
    revision: 3,
    sourceRunId: null,
    eveningIntent: {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    },
    blocks: [
      block("b1", {
        taskId: "t1",
        position: 0,
        pendingChange: { kind: "add", startsAt: "2026-09-10T16:00:00.000Z", durationMinutes: 30 }
      }),
      block("b2", {
        taskId: "t2",
        position: 1,
        actualPlacement: {
          startsAt: "2026-09-10T21:00:00.000Z",
          durationMinutes: 60,
          calendarEventRef: "ev-1"
        }
      }),
      block("b3", { taskId: "t3", position: 2 })
    ]
  };
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const calls: Call[] = [];
let draftPlan: DayPlanDto;
let applyMode: "report" | "confirm" = "report";
let previewConflictIds: string[] = [];

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: async () => JSON.stringify(data)
  };
}

function previewResponse(): PreviewDayPlanResponse {
  return {
    revision: draftPlan.revision,
    calendarAvailability: "available",
    calendarAsOf: null,
    blocks: [],
    eligibleBlockIds: ["b1", "b2"].filter((id) => !previewConflictIds.includes(id)),
    conflicts: previewConflictIds.map((blockId) => ({
      blockId,
      kind: "calendar_busy" as const,
      withBlockId: null,
      detail: "Overlaps Team sync",
      calendarEvent: null
    }))
  };
}

function appliedReport(ids: readonly string[]): ApplyExecutionReport {
  return {
    operationId: "op-1",
    planId: "plan-1",
    status: "completed",
    items: ids.map((blockId, index) => ({
      itemId: `item-${index}`,
      blockId,
      outcome: "applied" as const,
      result: {
        status: "applied" as const,
        providerEventId: "ev-9",
        startsAt: "2026-09-10T16:00:00.000Z",
        durationMinutes: 30,
        calendarMirror: "written" as const,
        blockMirror: "mirrored" as const
      }
    }))
  };
}

function installFetch() {
  globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    calls.push({ method, url: href, body });
    const draft = href.match(/\/api\/calendar\/day-plans\/([^/]+)\/draft$/);
    if (draft && method === "PATCH") {
      const input = body as {
        expectedRevision: number;
        blocks?: { id?: string; pendingChange?: unknown }[];
      };
      if (input.expectedRevision !== draftPlan.revision) return json({ error: "changed" }, 409);
      for (const row of input.blocks ?? []) {
        const target = draftPlan.blocks.find((entry) => entry.id === row.id);
        if (target)
          target.pendingChange = (row.pendingChange ?? null) as DayPlanBlockDto["pendingChange"];
      }
      draftPlan = { ...draftPlan, revision: draftPlan.revision + 1 };
      return json({ plan: draftPlan });
    }
    if (href.endsWith("/preview") && method === "POST") return json(previewResponse());
    if (href.endsWith("/apply") && method === "POST") {
      const input = body as { selectedBlockIds?: readonly string[] };
      if (applyMode === "confirm") {
        return json(
          {
            status: "confirmation-required",
            operationId: "op-2",
            approvalId: "appr-1",
            changes: [
              {
                blockId: "b2",
                kind: "move",
                calendarEventRef: "ev-1",
                startsAt: "2026-09-10T22:00:00.000Z",
                durationMinutes: 60
              }
            ]
          },
          202
        );
      }
      return json(appliedReport(input.selectedBlockIds ?? []));
    }
    throw new Error(`unexpected fetch ${method} ${href}`);
  }) as unknown as typeof fetch;
}

const liveRoots: ReturnType<typeof createRoot>[] = [];

function Harness(props: { plan: DayPlanDto; seen: (controller: DayPlanReviewController) => void }) {
  const controller = useDayPlanReview({
    plan: props.plan,
    localDay: DAY,
    timeZone: TZ,
    morningDefinitionId: null
  });
  useEffect(() => {
    props.seen(controller);
  }, [controller, props]);
  return null;
}

async function mountHook(plan: DayPlanDto): Promise<{ current: () => DayPlanReviewController }> {
  let latest: DayPlanReviewController | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  liveRoots.push(root);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, {
          plan,
          seen: (c) => {
            latest = c;
          }
        })
      )
    );
  });
  if (!latest) throw new Error("hook did not render");
  return { current: () => latest as DayPlanReviewController };
}

beforeEach(() => {
  calls.length = 0;
  draftPlan = plan();
  applyMode = "report";
  previewConflictIds = [];
  installFetch();
});

afterEach(async () => {
  for (const root of liveRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function order(urlSuffix: string): number {
  return calls.findIndex((call) => call.url.endsWith(urlSuffix));
}

describe("useDayPlanReview saveChanges", () => {
  it("sends draft, preview, then apply with the bodies Preview then Apply send", async () => {
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b2", "move", "2026-09-10T22:00:00.000Z");
    });
    await act(async () => {
      expect(await current().saveChanges()).toBe(true);
    });
    const draft = calls.find((call) => call.url.endsWith("/draft"));
    const sentB2 = (
      draft?.body as { blocks: { id: string; pendingChange: unknown }[] }
    ).blocks.find((row) => row.id === "b2");
    expect(sentB2?.pendingChange).toEqual({
      kind: "move",
      startsAt: "2026-09-10T22:00:00.000Z",
      durationMinutes: 60
    });
    const previews = calls.filter((call) => call.url.endsWith("/preview"));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.body).toMatchObject({
      expectedRevision: 4,
      selectedChangeBlockIds: ["b2"]
    });
    const applies = calls.filter((call) => call.url.endsWith("/apply"));
    expect(applies).toHaveLength(1);
    expect(applies[0]!.body).toMatchObject({ expectedRevision: 4, selectedBlockIds: ["b1", "b2"] });
    expect(applies[0]!.body).toHaveProperty("idempotencyKey");
    expect(order("/draft")).toBeLessThan(order("/preview"));
    expect(order("/preview")).toBeLessThan(order("/apply"));
    expect(calls.some((call) => call.url.endsWith("/confirm"))).toBe(false);
    expect(current().outcomes["b2"]?.outcome).toBe("applied");
  });

  it("leaves conflicted rows unapplied with their choices kept", async () => {
    previewConflictIds = ["b2"];
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b2", "move", "2026-09-10T22:00:00.000Z");
    });
    await act(async () => {
      expect(await current().saveChanges()).toBe(true);
    });
    const applies = calls.filter((call) => call.url.endsWith("/apply"));
    expect(applies).toHaveLength(1);
    expect(applies[0]!.body).toMatchObject({ selectedBlockIds: ["b1"] });
    expect(current().outcomes["b2"]).toBe(undefined);
    expect(current().choices["b2"]).toMatchObject({ placement: "move" });
  });

  it("stays unsupported for leave-only choices, as today", async () => {
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b3", "leave");
    });
    await act(async () => {
      expect(await current().saveChanges()).toBe(false);
    });
    expect(calls.some((call) => call.url.endsWith("/draft"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/preview"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/apply"))).toBe(false);
  });

  it("keeps the confirmation request for the Confirm block instead of applying", async () => {
    applyMode = "confirm";
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b2", "move", "2026-09-10T22:00:00.000Z");
    });
    await act(async () => {
      expect(await current().saveChanges()).toBe(true);
    });
    expect(current().approval).not.toBe(null);
    expect(current().approval?.changes[0]?.blockId).toBe("b2");
    expect(calls.some((call) => call.url.endsWith("/confirm"))).toBe(false);
  });
});
