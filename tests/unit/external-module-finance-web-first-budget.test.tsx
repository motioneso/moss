// @vitest-environment jsdom
//
// #3160 review: the first-budget screen. Server answers come through a faked fetch at the
// network edge; the screen, its store and its timers run for real.
import "./helpers/install-module-runtime";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FirstBudget } from "../../external-modules/finance/src/web/screens/first-budget";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const calls: string[] = [];

function draftBody(planCents: number): Record<string, unknown> {
  return {
    status: "ok",
    revision: 7,
    fingerprint: "a".repeat(32),
    hasSynced: true,
    hasBudget: false,
    draft: {
      isoCurrency: "USD",
      id: "d1",
      status: "open",
      basisFrom: "2026-07-01",
      basisTo: "2026-09-30",
      monthlyIncomeCents: 500000,
      totalCents: planCents,
      unplannedCents: 500000 - planCents,
      groups: [
        {
          name: "Everyday",
          lines: [
            {
              categoryKey: "groceries",
              isoCurrency: "USD",
              categoryName: "Groceries",
              basisMonthlyCents: 25000,
              planCents,
              dropped: false,
              changedByMoss: false,
              proposedCents: 25000
            }
          ]
        }
      ]
    }
  };
}

/** Fake server. `draftRead` decides what each re-read of the draft returns. */
function install(opts: {
  draftRead: () => Record<string, unknown>;
  queue?: (name: string) => number;
}): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes("/assistant-tools/finance.budget.draft.get/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ invocation: { status: "succeeded", result: opts.draftRead() } })
        };
      }
      const queue = /queues\/([^/]+)\/run/.exec(url)?.[1];
      if (queue) {
        calls.push(`${queue}:${init?.body ?? ""}`);
        const status = opts.queue ? opts.queue(queue) : 202;
        return { ok: status < 300, status, json: async () => ({ jobId: "j1" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
}

async function render(tools?: ExternalModuleToolsHandleV1): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(FirstBudget, {
        hostActions: { openAssistant: () => {} },
        tools,
        fallback: createElement("span", null, "fallback")
      })
    );
  });
  await act(async () => {});
  return renderer;
}

function collect(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(collect).join(" ");
  return collect((node as { children?: unknown }).children);
}
const text = (renderer: ReactTestRenderer): string => collect(renderer.toJSON());

const buttonWith = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    (n) => n.type === "button" && collect(n.props.children).includes(label)
  )[0]!;

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  __resetStoreForTests();
  vi.unstubAllGlobals();
});

describe("first budget screen (#3160 review)", () => {
  it("requires saving typed amounts before starting and sends the current review", async () => {
    let saved = 25000;
    install({ draftRead: () => draftBody(saved) });
    const invoke = vi.fn(async (tool: string): Promise<ModuleToolOutcome> => {
      if (tool === "finance.budget.draft.update") {
        saved = 60000;
        return { status: "succeeded", result: { status: "ok" } };
      }
      return { status: "cancelled" };
    });
    const renderer = await render({ invoke });
    const field = () =>
      renderer.root.findAll(
        (n) => n.type === "input" && n.props["aria-label"] === "Plan for Groceries"
      )[0]!;
    await act(async () => field().props.onFocus({ currentTarget: { select() {} } }));
    await act(async () => field().props.onChange({ currentTarget: { value: "600" } }));
    await act(async () => buttonWith(renderer, "Start this budget").props.onClick());
    expect(invoke).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Save your typed amounts");
    await act(async () => field().props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(field().props.value).toBe("$600.00");
    expect(invoke).toHaveBeenNthCalledWith(1, "finance.budget.draft.update", {
      draftId: "d1",
      categoryKey: "groceries",
      amountCents: 60000,
      expectedRevision: 7,
      expectedFingerprint: "a".repeat(32)
    });
    await act(async () => buttonWith(renderer, "Start this budget").props.onClick());
    expect(invoke).toHaveBeenNthCalledWith(2, "finance.budget.draft.start", {
      draftId: "d1",
      expectedRevision: 7,
      expectedFingerprint: "a".repeat(32)
    });
    expect(text(renderer)).toContain("Cancelled");
    expect(field().props.value).toBe("$600.00");
  });

  it("requires checking saved records after an ambiguous start and never automatically retries", async () => {
    install({ draftRead: () => draftBody(25000) });
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    const renderer = await render({ invoke });
    await act(async () => buttonWith(renderer, "Start this budget").props.onClick());
    expect(text(renderer)).toContain("could not be confirmed");
    expect(buttonWith(renderer, "Start this budget").props.disabled).toBe(true);
    await tick(40000);
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => buttonWith(renderer, "Check saved draft").props.onClick());
    expect(buttonWith(renderer, "Start this budget").props.disabled).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("sends the build again when Try again is pressed after a failed build", async () => {
    install({
      draftRead: () => ({ status: "ok", hasSynced: true, hasBudget: false, draft: null })
    });
    const invoke = vi.fn(
      async (): Promise<ModuleToolOutcome> => ({
        status: "succeeded",
        result: { status: "ok", reason: "no-history" }
      })
    );
    const renderer = await render({ invoke });
    expect(text(renderer)).toContain("not enough usable history");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("finance.budget.draft.build", {});
    await act(async () => {
      buttonWith(renderer, "Try again").props.onClick();
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
