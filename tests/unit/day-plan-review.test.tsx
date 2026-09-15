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
  DayPlanTaskSummary,
  LocaleSettingsDto,
  PreviewDayPlanResponse
} from "@moss/shared";

import {
  defaultChoiceFor,
  isoToLocalTime,
  localTimeToIso
} from "../../apps/web/src/today/day-plan-review-model.js";
import {
  useDayPlanReview,
  type DayPlanReviewController
} from "../../apps/web/src/today/day-plan-review-controller.js";
import { DayPlanReview } from "../../apps/web/src/today/day-plan-review.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TZ = "America/Los_Angeles";
const DAY = "2026-09-10";
const NOW = "2026-09-10T16:00:00.000Z";
const locale: LocaleSettingsDto = { timezone: TZ, region: "en-US", dateFormat: "12" };

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

function task(id: string, title: string, dueAt: string | null = null): DayPlanTaskSummary {
  return { id, title, status: "todo", dueAt, doAt: null, effort: null };
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

function tasks(): DayPlanTaskSummary[] {
  return [
    task("t1", "Write the launch brief"),
    task("t2", "Call the vendor"),
    task("t3", "File the report", "2026-09-12T00:00:00.000Z")
  ];
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const calls: Call[] = [];
let draftPlan: DayPlanDto;
let applyMode: "report" | "confirm" | "partial" | "denied" | "pending" | "pending-whole-plan" =
  "report";
let confirmStale = false;
let availability: PreviewDayPlanResponse["calendarAvailability"] = "available";

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : "OK",
    text: async () => JSON.stringify(data)
  };
}

function previewResponse(): PreviewDayPlanResponse {
  return {
    revision: draftPlan.revision,
    calendarAvailability: availability,
    calendarAsOf: null,
    blocks: [
      {
        blockId: "b1",
        taskId: "t1",
        changeKind: "add",
        before: null,
        after: { startsAt: "2026-09-10T16:00:00.000Z", durationMinutes: 30 },
        eligible: true,
        ineligibleReason: null,
        deadlineRisk: false
      }
    ],
    eligibleBlockIds: ["b1"],
    conflicts: []
  };
}

function appliedReport(): ApplyExecutionReport {
  return {
    operationId: "op-1",
    planId: "plan-1",
    status: "completed",
    items: [
      {
        itemId: "item-1",
        blockId: "b1",
        outcome: "applied",
        result: {
          status: "applied",
          providerEventId: "ev-9",
          startsAt: "2026-09-10T16:00:00.000Z",
          durationMinutes: 30,
          calendarMirror: "written",
          blockMirror: "mirrored"
        }
      }
    ]
  };
}

function installFetch() {
  globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    calls.push({ method, url: href, body });
    if (href.endsWith("/api/calendar/briefing-settings")) {
      return json({
        settings: {
          lookaheadDays: 1,
          prepTaskMode: "suggest",
          timeBlockMode: "suggest",
          suggestTasks: true,
          createTasks: false,
          suggestTimeBlocks: true,
          blockTime: false
        }
      });
    }
    const draft = href.match(/\/api\/calendar\/day-plans\/([^/]+)\/draft$/);
    if (draft && method === "PATCH") {
      const input = body as {
        expectedRevision: number;
        blocks?: { id?: string; pendingChange?: unknown }[];
      };
      if (input.expectedRevision !== draftPlan.revision) return json({ error: "changed" }, 409);
      for (const row of input.blocks ?? []) {
        const target = draftPlan.blocks.find((entry) => entry.id === row.id);
        if (target) {
          target.pendingChange = (row.pendingChange ?? null) as DayPlanBlockDto["pendingChange"];
        }
      }
      draftPlan = { ...draftPlan, revision: draftPlan.revision + 1 };
      return json({ plan: draftPlan });
    }
    if (href.endsWith("/preview") && method === "POST") {
      const input = body as { expectedRevision: number };
      if (input.expectedRevision !== draftPlan.revision) return json({ error: "changed" }, 409);
      return json(previewResponse());
    }
    if (href.endsWith("/apply") && method === "POST") {
      const input = body as { expectedRevision: number };
      if (input.expectedRevision !== draftPlan.revision) return json({ error: "changed" }, 409);
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
      if (applyMode === "denied") {
        return json({
          operationId: "op-9",
          planId: "plan-1",
          status: "denied",
          denialReason: "conflict: reserved additions overlap protected time (b1:calendar_busy)",
          items: []
        });
      }
      if (applyMode === "pending") {
        return json({
          operationId: "op-8",
          planId: "plan-1",
          status: "denied",
          denialReason: "facts-unavailable: current calendar facts are incomplete",
          items: [
            {
              itemId: "item-8",
              blockId: "b1",
              outcome: "pending",
              result: null
            }
          ]
        });
      }
      if (applyMode === "pending-whole-plan") {
        // The real facts-unavailable denial reports every plan block as
        // pending, not only the ones this batch selected.
        return json({
          operationId: "op-8",
          planId: "plan-1",
          status: "denied",
          denialReason: "facts-unavailable: current calendar facts are incomplete",
          items: [
            { itemId: "item-8", blockId: "b1", outcome: "pending", result: null },
            { itemId: "item-10", blockId: "b2", outcome: "pending", result: null },
            { itemId: "item-11", blockId: "b3", outcome: "pending", result: null }
          ]
        });
      }
      if (applyMode === "partial") {
        const report = appliedReport();
        report.items = [
          ...report.items,
          {
            itemId: "item-9",
            blockId: "b3",
            outcome: "failed",
            result: { status: "failed", reason: "conflict" }
          }
        ];
        return json(report);
      }
      return json(appliedReport());
    }
    if (href.endsWith("/confirm") && method === "POST") {
      if (confirmStale) return json({ error: "stale" }, 409);
      return json(appliedReport());
    }
    if (href.endsWith("/retry") && method === "POST") return json(appliedReport());
    throw new Error(`unexpected fetch ${method} ${href}`);
  }) as unknown as typeof fetch;
}

const liveRoots: ReturnType<typeof createRoot>[] = [];

function Harness(props: { plan: DayPlanDto; seen: (controller: DayPlanReviewController) => void }) {
  const controller = useDayPlanReview({
    plan: props.plan,
    localDay: DAY,
    timeZone: TZ,
    morningDefinitionId: "def-morning"
  });
  useEffect(() => {
    props.seen(controller);
  }, [controller, props]);
  return null;
}

async function mountHook(
  plan: DayPlanDto
): Promise<{ current: () => DayPlanReviewController; client: QueryClient }> {
  let latest: DayPlanReviewController | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  void invalidate;
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
          seen: (controller) => {
            latest = controller;
          }
        })
      )
    );
  });
  if (!latest) throw new Error("hook did not render");
  return { current: () => latest as DayPlanReviewController, client };
}

beforeEach(() => {
  calls.length = 0;
  draftPlan = plan();
  applyMode = "report";
  confirmStale = false;
  availability = "available";
  installFetch();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(async () => {
  for (const root of liveRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("day-plan-review time model", () => {
  it("round-trips a plan-zone wall time through UTC", () => {
    expect(localTimeToIso(DAY, "09:00", TZ)).toBe("2026-09-10T16:00:00.000Z");
    expect(isoToLocalTime("2026-09-10T16:00:00.000Z", TZ)).toBe("09:00");
    expect(localTimeToIso(DAY, "nope", TZ)).toBe(null);
  });

  it("starts neutral and derives duration from the block, never a default", () => {
    const [pending, placed, bare] = plan().blocks;
    // Neutral keeps mirror the saved state without selecting anything.
    expect(defaultChoiceFor(pending!)).toEqual({ placement: "keep-proposed", startsAt: null });
    expect(defaultChoiceFor(placed!)).toEqual({ placement: "keep-proposed", startsAt: null });
    expect(defaultChoiceFor(bare!)).toEqual({ placement: "keep-proposed", startsAt: null });
  });

  it("previews only touched rows, never untouched saved proposals", async () => {
    const { current } = await mountHook(plan());
    await act(async () => {
      expect(await current().runPreview()).toBe(false);
    });
    expect(calls.some((call) => call.url.endsWith("/preview"))).toBe(false);
    expect(current().notice).toMatch(/No changes to preview yet/);
    // An explicit Add identical to the saved proposal still counts as chosen.
    await act(async () => {
      current().setPlacement("b1", "add", "2026-09-10T16:00:00.000Z");
    });
    await act(async () => {
      expect(await current().runPreview()).toBe(true);
    });
    const preview = calls.find((call) => call.url.endsWith("/preview"));
    expect(preview?.body).toMatchObject({ selectedChangeBlockIds: ["b1"] });
  });
});

describe("useDayPlanReview writes", () => {
  it("previews then applies additions and invalidates the exact query set", async () => {
    const { current, client } = await mountHook(plan());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      current().setPlacement("b1", "leave");
    });
    await act(async () => {
      current().setPlacement("b1", "add", "2026-09-10T18:00:00.000Z");
    });
    await act(async () => {
      expect(await current().runPreview()).toBe(true);
    });
    expect(current().preview?.eligibleBlockIds).toEqual(["b1"]);
    await act(async () => {
      expect(await current().apply(["b1"])).toBe(true);
    });
    expect(current().outcomes["b1"]?.outcome).toBe("applied");
    expect(current().approval).toBe(null);
    const keys = invalidate.mock.calls.map((args) => (args[0] as { queryKey: unknown }).queryKey);
    const unique = new Set(keys.map((key) => JSON.stringify(key)));
    // Preview and apply each invalidate the same four keys, nothing else.
    expect(unique).toEqual(
      new Set(
        [
          ["calendar", "day-plan", DAY, TZ],
          ["calendar", "list"],
          ["tasks", "list"],
          ["briefings", "runs", "def-morning"]
        ].map((key) => JSON.stringify(key))
      )
    );
    // The draft carries every block, since a draft save replaces the whole
    // list; untouched rows keep their saved state so the server keeps them.
    const draft = calls.find((call) => call.url.endsWith("/draft"));
    expect(draft?.body).toMatchObject({ expectedRevision: 3 });
    const sent = (draft?.body as { blocks: { id: string }[] }).blocks.map((row) => row.id);
    expect(sent).toEqual(["b1", "b2", "b3"]);
    expect(draft?.body).toMatchObject({
      blocks: [
        {
          id: "b1",
          pendingChange: {
            kind: "add",
            startsAt: "2026-09-10T18:00:00.000Z",
            durationMinutes: 30
          }
        },
        { id: "b2", pendingChange: null },
        { id: "b3", pendingChange: null }
      ]
    });
  });

  it("clears a saved add when the choice is leave unscheduled, instead of resending it", async () => {
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b1", "leave");
    });
    // b1's only change is "leave", which clears a saved add rather than
    // adding, moving or removing, so there is nothing eligible to preview;
    // the draft save still happens and is what this test checks.
    await act(async () => {
      await current().runPreview();
    });
    const draft = calls.find((call) => call.url.endsWith("/draft"));
    const sentB1 = (
      draft?.body as { blocks: { id: string; pendingChange: unknown }[] }
    ).blocks.find((row) => row.id === "b1");
    expect(sentB1?.pendingChange).toBe(null);
  });

  it("uses one idempotency key per selection attempt", async () => {
    const { current } = await mountHook(plan());
    await act(async () => {
      await current().apply(["b1"]);
      await current().apply(["b1"]);
    });
    const bodies = calls
      .filter((call) => call.url.endsWith("/apply"))
      .map((call) => call.body as { idempotencyKey: string; selectedBlockIds: string[] });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.idempotencyKey).toBe(bodies[1]!.idempotencyKey);
    await act(async () => {
      await current().apply(["b1", "b2"]);
    });
    const third = calls.filter((call) => call.url.endsWith("/apply"))[2]!.body as {
      idempotencyKey: string;
    };
    expect(third.idempotencyKey).not.toBe(bodies[0]!.idempotencyKey);
  });

  it("asks for confirmation on a move and confirms with the approval id", async () => {
    applyMode = "confirm";
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b2", "move", "2026-09-10T22:00:00.000Z");
    });
    await act(async () => {
      expect(await current().apply(["b2"])).toBe(true);
    });
    expect(current().approval?.approvalId).toBe("appr-1");
    expect(calls.some((call) => call.url.endsWith("/confirm"))).toBe(false);
    await act(async () => {
      expect(await current().confirm()).toBe(true);
    });
    const confirm = calls.find((call) => call.url.endsWith("/confirm"));
    expect(confirm?.body).toEqual({ approvalId: "appr-1" });
    expect(confirm?.url).toContain("/operations/op-2/confirm");
    expect(current().approval).toBe(null);
  });

  it("dismisses the confirmation and starts over when the selection changes", async () => {
    applyMode = "confirm";
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b2", "move", "2026-09-10T22:00:00.000Z");
      await current().apply(["b2"]);
    });
    expect(current().approval).not.toBe(null);
    await act(async () => {
      current().dismissApproval();
    });
    expect(current().approval).toBe(null);
    await act(async () => {
      current().setPlacement("b2", "keep");
      await current().apply(["b2"]);
    });
    // A changed selection is a new apply, not a confirm of the old approval.
    expect(calls.some((call) => call.url.endsWith("/confirm"))).toBe(false);
    expect(calls.filter((call) => call.url.endsWith("/apply"))).toHaveLength(2);
  });

  it("reruns the preview instead of retrying a stale confirm", async () => {
    applyMode = "confirm";
    confirmStale = true;
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b2", "move", "2026-09-10T22:00:00.000Z");
    });
    await act(async () => {
      expect(await current().apply(["b2"])).toBe(true);
    });
    expect(current().approval?.approvalId).toBe("appr-1");
    await act(async () => {
      expect(await current().confirm()).toBe(false);
    });
    expect(calls.filter((call) => call.url.endsWith("/confirm"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/preview")).length).toBeGreaterThan(0);
    expect(current().approval).toBe(null);
    expect(current().notice).toMatch(/expired/);
  });

  it("keeps choices and marks rows when a save hits a 409", async () => {
    const first = plan();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let latest: DayPlanReviewController | null = null;
    const renderPlan = async (value: DayPlanDto) => {
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(Harness, {
              plan: value,
              seen: (controller) => {
                latest = controller;
              }
            })
          )
        );
      });
    };
    await renderPlan(first);
    const current = () => latest as DayPlanReviewController;
    await act(async () => {
      current().setPlacement("b3", "add", "2026-09-10T18:00:00.000Z");
    });
    // Another writer moves b2 and bumps the revision; our draft now conflicts.
    draftPlan = {
      ...draftPlan,
      revision: 9,
      blocks: draftPlan.blocks.map((entry) =>
        entry.id === "b2"
          ? {
              ...entry,
              pendingChange: {
                kind: "move" as const,
                startsAt: entry.actualPlacement!.startsAt!,
                durationMinutes: 60
              }
            }
          : entry
      )
    };
    await act(async () => {
      expect(await current().runPreview()).toBe(false);
    });
    // The 409 reloads the plan; the refetch arrives with the new revision.
    await renderPlan(draftPlan);
    expect(current().choices["b3"]).toMatchObject({ placement: "add" });
    expect(current().changedIds).toEqual(["b2"]);
    expect(current().stalePreview).toBe(true);
    expect(current().preview).toBe(null);
    expect(current().notice).toMatch(/changed since it was read/);
  });

  it("surfaces a whole-batch denial with its reason and writes nothing", async () => {
    applyMode = "denied";
    const { current } = await mountHook(plan());
    await act(async () => {
      expect(await current().apply(["b1"])).toBe(true);
    });
    expect(current().notice).toMatch(/refused.*conflict/);
    expect(current().outcomes["b1"]).toBe(undefined);
  });

  it("never sends pending outcomes to the retry route", async () => {
    applyMode = "pending";
    const { current } = await mountHook(plan());
    await act(async () => {
      expect(await current().apply(["b1"])).toBe(true);
    });
    expect(current().outcomes["b1"]?.outcome).toBe("pending");
    expect(current().notice).toMatch(/refused.*facts-unavailable/);
    await act(async () => {
      expect(await current().retry()).toBe(false);
    });
    expect(calls.some((call) => call.url.endsWith("/retry"))).toBe(false);
  });

  it("scopes a one-item apply's outcomes to what was selected, not the whole plan", async () => {
    applyMode = "pending-whole-plan";
    const { current } = await mountHook(plan());
    await act(async () => {
      expect(await current().apply(["b1"])).toBe(true);
    });
    expect(current().outcomes["b1"]?.outcome).toBe("pending");
    expect(current().outcomes["b2"]).toBe(undefined);
    expect(current().outcomes["b3"]).toBe(undefined);
  });

  it("retries only unresolved items with the original operation id", async () => {
    applyMode = "partial";
    const { current } = await mountHook(plan());
    await act(async () => {
      current().setPlacement("b3", "leave");
    });
    await act(async () => {
      await current().apply(["b1", "b3"]);
    });
    expect(current().outcomes["b1"]?.outcome).toBe("applied");
    expect(current().outcomes["b3"]?.outcome).toBe("failed");
    // The failed row keeps its choice, so a re-preview still covers it.
    expect(current().choices["b3"]).toMatchObject({ placement: "leave" });
    await act(async () => {
      expect(await current().retry()).toBe(true);
    });
    const retry = calls.find((call) => call.url.endsWith("/retry"));
    expect(retry?.url).toContain("/operations/op-1/retry");
    expect(retry?.body).toEqual({ itemIds: ["item-9"] });
  });
});

describe("DayPlanReview view", () => {
  function stubController(
    overrides: Partial<DayPlanReviewController> = {}
  ): DayPlanReviewController {
    const choices = overrides.choices ?? {};
    return {
      choices,
      touchedIds: Object.keys(choices),
      revision: 3,
      changedIds: [],
      stalePreview: false,
      preview: null,
      approval: null,
      outcomes: {},
      notice: null,
      busy: false,
      choiceFor: (block) => choices[block.id] ?? defaultChoiceFor(block),
      setPlacement: () => undefined,
      dismissApproval: () => undefined,
      setTime: () => undefined,
      runPreview: async () => true,
      apply: async () => true,
      confirm: async () => true,
      retry: async () => true,
      ...overrides
    };
  }

  async function renderReview(
    controller: DayPlanReviewController,
    options: { unavailable?: string[]; planBlocks?: DayPlanBlockDto[] } = {}
  ): Promise<HTMLElement> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);
    const base = plan();
    const target: DayPlanDto = options.planBlocks ? { ...base, blocks: options.planBlocks } : base;
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(DayPlanReview, {
            controller,
            plan: target,
            tasks: tasks(),
            unavailableTaskIds: options.unavailable ?? [],
            events: [],
            locale,
            now: new Date(NOW),
            opener: null,
            onClose: () => undefined,
            onOpenTask: () => undefined
          })
        )
      );
    });
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {});
    }
    // BriefingDialog renders in a portal on document.body, outside the root.
    return document.body as unknown as HTMLElement;
  }

  function names(container: HTMLElement): string[] {
    return [...container.querySelectorAll("button,select,input")]
      .map((node) => node.getAttribute("aria-label") ?? node.textContent ?? "")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  }

  it("renders titled rows with no Accept-all control", async () => {
    const container = await renderReview(stubController());
    const all = names(container);
    expect(all.some((name) => /accept all/i.test(name))).toBe(false);
    expect(all).toContain("Write the launch brief: placement");
    expect(all).toContain("Preview changes");
    expect(all).toContain("Apply changes");
    expect(all).toContain("Back to Today");
    expect(container.textContent).toContain("Proposed, not on the calendar yet");
  });

  it("reads unsaved deltas in transient words", async () => {
    const container = await renderReview(
      stubController({
        choices: {
          b1: { placement: "remove", startsAt: null },
          b2: { placement: "move", startsAt: "2026-09-10T22:00:00.000Z" }
        }
      })
    );
    expect(container.textContent).toContain("Will be removed");
    expect(container.textContent).toContain("Time change to save");
  });

  it("shows the server confirmation with task names and no silent confirm", async () => {
    const confirm = vi.fn(async () => true);
    const container = await renderReview(
      stubController({
        approval: {
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
          ],
          selection: ["b2"],
          idempotencyKey: "review-1"
        },
        confirm
      })
    );
    const region = container.querySelector("section.plan-review__confirm");
    expect(region?.textContent).toContain("Confirm calendar changes");
    expect(region?.textContent).toContain("Call the vendor");
    expect(region?.textContent).toContain("tasks themselves remain");
    expect(document.querySelectorAll("section.plan-review__confirm")).toHaveLength(1);
  });

  it("redacts unreadable tasks and shows the due consequence", async () => {
    const container = await renderReview(
      stubController({
        choices: { b3: { placement: "leave", startsAt: null } }
      }),
      { unavailable: ["t1"] }
    );
    expect(container.textContent).toContain("No longer available");
    expect(names(container)).not.toContain("Write the launch brief: placement");
    expect(container.textContent).toMatch(/Due .*no time set/);
  });

  it("disables Add on a block with no duration to schedule", async () => {
    const container = await renderReview(stubController());
    const select = container.querySelector(
      'select[aria-label="File the report: placement"]'
    ) as HTMLSelectElement | null;
    expect(select).not.toBe(null);
    const add = [...(select?.options ?? [])].find((option) => option.value === "add");
    expect(add?.disabled).toBe(true);
  });

  it("applies only conflict-free eligible blocks", async () => {
    const apply = vi.fn(async () => true);
    const container = await renderReview(
      stubController({
        preview: {
          revision: 4,
          calendarAvailability: "available",
          calendarAsOf: null,
          blocks: [],
          eligibleBlockIds: ["b1", "b2"],
          conflicts: [
            {
              blockId: "b2",
              kind: "calendar_busy",
              withBlockId: null,
              detail: "Overlaps lunch",
              calendarEvent: null
            }
          ]
        },
        apply
      })
    );
    const target = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Apply changes"
    ) as HTMLButtonElement;
    expect(target.disabled).toBe(false);
    await act(async () => {
      target.click();
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(["b1"]);
  });

  it("offers Retry only for failed or unknown outcomes, never pending", async () => {
    const pendingOnly = await renderReview(
      stubController({
        outcomes: {
          b1: { itemId: "item-8", blockId: "b1", outcome: "pending", result: null }
        }
      })
    );
    expect(pendingOnly.textContent).toContain("0 failed; 1 pending");
    expect(
      [...pendingOnly.querySelectorAll("button")].some((node) => node.textContent === "Retry")
    ).toBe(false);
    const failed = await renderReview(
      stubController({
        outcomes: {
          b1: { itemId: "item-8", blockId: "b1", outcome: "failed", result: null }
        }
      })
    );
    expect(
      [...failed.querySelectorAll("button")].some((node) => node.textContent === "Retry")
    ).toBe(true);
  });

  it("counts outcomes honestly and disables apply without a calendar", async () => {
    const container = await renderReview(
      stubController({
        preview: {
          revision: 4,
          calendarAvailability: "unavailable",
          calendarAsOf: null,
          blocks: [],
          eligibleBlockIds: [],
          conflicts: []
        },
        outcomes: {
          b1: {
            itemId: "item-1",
            blockId: "b1",
            outcome: "applied",
            result: {
              status: "applied",
              providerEventId: "ev-9",
              startsAt: "2026-09-10T16:00:00.000Z",
              durationMinutes: 30,
              calendarMirror: "written",
              blockMirror: "mirrored"
            }
          },
          b2: {
            itemId: "item-2",
            blockId: "b2",
            outcome: "failed",
            result: { status: "failed", reason: "conflict" }
          }
        }
      })
    );
    expect(container.textContent).toContain("Applied 1; 1 failed; 0 pending.");
    expect(container.textContent).toContain("Partially applied");
    expect(container.textContent).not.toMatch(/nothing changed/i);
    const apply = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Apply changes"
    );
    expect(apply?.disabled).toBe(true);
    expect(container.textContent).toContain("calendar is unavailable");
  });
});
