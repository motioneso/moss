// @vitest-environment jsdom
//
// #3160 review: the first-budget screen. Server answers come through a faked fetch at the
// network edge; the screen, its store and its timers run for real.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FirstBudget } from "../../external-modules/finance/src/web/screens/first-budget";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const calls: string[] = [];

function draftBody(planCents: number): Record<string, unknown> {
  return {
    status: "ok",
    hasSynced: true,
    hasBudget: false,
    draft: {
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

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(FirstBudget, {
        hostActions: { openAssistant: () => {} },
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
  it("holds Start until a typed amount is saved, then starts with the saved amount", async () => {
    let saved = 25000;
    install({
      draftRead: () => draftBody(saved),
      queue: (name) => {
        if (name === "finance.draft-set") saved = 60000;
        return 202;
      }
    });
    const renderer = await render();
    const field = () =>
      renderer.root.findAll(
        (n) => n.type === "input" && n.props["aria-label"] === "Plan for Groceries"
      )[0]!;
    await act(async () => {
      field().props.onFocus({ currentTarget: { select: () => {} } });
    });
    await act(async () => {
      field().props.onChange({ currentTarget: { value: "600" } });
    });
    await act(async () => {
      field().props.onBlur();
    });
    await act(async () => {
      buttonWith(renderer, "Start this budget").props.onClick();
    });

    expect(calls.some((c) => c.startsWith("finance.draft-set"))).toBe(true);
    expect(calls.some((c) => c.startsWith("finance.draft-start"))).toBe(false);

    await tick(3100);
    await tick(10);
    const order = calls.map((c) => c.split(":")[0]);
    expect(order.indexOf("finance.draft-start")).toBeGreaterThan(
      order.indexOf("finance.draft-set")
    );
  });

  it("shows an error and a working button when a queued start never finishes", async () => {
    install({ draftRead: () => draftBody(25000) });
    const renderer = await render();
    await act(async () => {
      buttonWith(renderer, "Start this budget").props.onClick();
    });
    await tick(10);
    expect(text(renderer)).toContain("Starting your budget");
    for (let i = 0; i < 11; i += 1) await tick(3100);
    expect(text(renderer)).toContain("Your budget did not start. Try again.");
    expect(buttonWith(renderer, "Start this budget").props.disabled).toBeFalsy();
  });

  it("sends the build again when Try again is pressed after a failed build", async () => {
    install({
      draftRead: () => ({ status: "ok", hasSynced: true, hasBudget: false, draft: null })
    });
    const renderer = await render();
    for (let i = 0; i < 11; i += 1) await tick(3100);
    expect(text(renderer)).toContain("Your draft could not be built.");
    const before = calls.filter((c) => c.startsWith("finance.draft-build")).length;
    await act(async () => {
      buttonWith(renderer, "Try again").props.onClick();
    });
    await tick(10);
    expect(calls.filter((c) => c.startsWith("finance.draft-build")).length).toBe(before + 1);
  });
});
