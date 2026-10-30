// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import { BudgetTargets } from "../../external-modules/finance/src/web/budget-targets";
import { targetSetHandler } from "../../external-modules/finance/src/worker/handlers/targets.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const tokens = { expectedRevision: 1, expectedFingerprint: "a".repeat(32) };
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name))!;
describe("weekly contribution editor", () => {
  it("requires an explicit weekday, explains the full month and saves only target metadata", async () => {
    const invoke = vi.fn(async () => ({ status: "cancelled" as const }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(BudgetTargets, {
          month: "2026-10",
          currency: "USD",
          revision: 1,
          fingerprint: tokens.expectedFingerprint,
          categories: [{ id: "groceries", name: "Groceries" }],
          targets: [],
          tools: { invoke }
        })
      );
    });
    await act(async () => button(renderer, "Add a target").props.onClick());
    const change = async (label: string, value: string) =>
      act(async () => {
        renderer.root
          .findByProps({ "aria-label": label })
          .props.onChange({ currentTarget: { value } });
      });
    await change("Target type", "weekly");
    await change("Target amount", "25.01");
    expect(button(renderer, "Save target").props.disabled).toBe(true);
    expect(renderer.root.findByProps({ "aria-label": "Contribution weekday" }).props.value).toBe(
      ""
    );
    await change("Contribution weekday", "5");
    const copy = JSON.stringify(renderer.toJSON());
    expect(copy).toContain("5 Fridays");
    expect(copy).toContain("$125.05");
    expect(copy).toContain("including when created mid-month");
    await act(async () => button(renderer, "Save target").props.onClick());
    expect(invoke).toHaveBeenCalledExactlyOnceWith("finance.target.set", {
      ...tokens,
      month: "2026-10",
      categoryId: "groceries",
      kind: "weekly",
      amountCents: 2501,
      weekday: 5
    });
    expect(renderer.root.findByProps({ "aria-label": "Contribution weekday" }).props.value).toBe(
      "5"
    );
  });
});
describe("weekly target write validation", () => {
  const setup = () => {
    const save = vi.fn(async () => true);
    const store = vi.fn(async () => ({
      budgetPolicy: {
        get: async () => ({
          revision: 1,
          fingerprint: tokens.expectedFingerprint,
          taxonomyReady: true,
          isoCurrency: "USD"
        })
      },
      targets: { save }
    }));
    const run = targetSetHandler({
      store,
      now: () => new Date("2026-10-30T12:00:00Z")
    } as unknown as WorkerPorts);
    return { save, store, run };
  };
  const input = {
    ...tokens,
    month: "2026-10",
    categoryId: "groceries",
    kind: "weekly",
    amountCents: 2501,
    weekday: 0
  };
  it("accepts Sunday zero and forwards the captured review with a metadata-only shape", async () => {
    const { run, save } = setup();
    expect(await run(input)).toMatchObject({ status: "ok" });
    expect(save).toHaveBeenCalledExactlyOnceWith(
      {
        categoryId: "groceries",
        effectiveMonth: "2026-10",
        kind: "weekly",
        amountCents: 2501,
        weekday: 0,
        dueDate: null
      },
      { revision: 1, fingerprint: tokens.expectedFingerprint },
      "2026-10-30T12:00:00.000Z"
    );
  });
  it.each([
    { weekday: undefined },
    { weekday: -1 },
    { weekday: 7 },
    { weekday: 1.5 },
    { amountCents: 1801439850948199 },
    { dueDate: "2026-10-31" },
    { kind: "monthly" },
    { kind: "removed", amountCents: 0 }
  ])("rejects invalid shape before opening storage: %j", async (invalid) => {
    const { run, store } = setup();
    await expect(run({ ...input, ...invalid })).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
  });
});
