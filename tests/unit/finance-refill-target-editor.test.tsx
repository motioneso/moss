// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import { BudgetTargets } from "../../external-modules/finance/src/web/budget-targets";
import { targetProgress } from "../../external-modules/finance/src/domain/targets.js";
import { targetSetHandler } from "../../external-modules/finance/src/worker/handlers/targets.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const tokens = { expectedRevision: 1, expectedFingerprint: "a".repeat(32) };
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name))!;
describe("monthly refill editor", () => {
  it("retains the explicit refill kind on edit and saves metadata without assigning money", async () => {
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
          targets: [
            targetProgress(
              {
                categoryId: "groceries",
                effectiveMonth: "2026-10",
                kind: "refill",
                amountCents: 12501,
                dueDate: null
              },
              undefined,
              "2026-10",
              "2026-10-30"
            )
          ],
          tools: { invoke }
        })
      );
    });
    await act(async () => button(renderer, "Edit target").props.onClick());
    expect(renderer.root.findByProps({ "aria-label": "Target type" }).props.value).toBe("refill");
    expect(renderer.root.findAllByProps({ "aria-label": "Contribution weekday" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ "aria-label": "Target date" })).toHaveLength(0);
    const copy = JSON.stringify(renderer.toJSON());
    expect(copy).toContain("Monthly refill");
    expect(copy).not.toContain("Counts carried money");
    await act(async () => button(renderer, "Save target").props.onClick());
    expect(invoke).toHaveBeenCalledExactlyOnceWith("finance.target.set", {
      ...tokens,
      month: "2026-10",
      categoryId: "groceries",
      kind: "refill",
      amountCents: 12501
    });
    expect(renderer.root.findByProps({ "aria-label": "Target type" }).props.value).toBe("refill");
  });
  it("validates refill metadata through the existing reviewed target save", async () => {
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
    const input = {
      ...tokens,
      month: "2026-10",
      categoryId: "groceries",
      kind: "refill",
      amountCents: 12501
    };
    for (const invalid of [{ weekday: 0 }, { dueDate: "2026-10-31" }, { amountCents: 0 }])
      await expect(run({ ...input, ...invalid })).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
    expect(await run(input)).toMatchObject({ status: "ok" });
    expect(save).toHaveBeenCalledExactlyOnceWith(
      {
        categoryId: "groceries",
        effectiveMonth: "2026-10",
        kind: "refill",
        amountCents: 12501,
        dueDate: null
      },
      { revision: 1, fingerprint: tokens.expectedFingerprint },
      "2026-10-30T12:00:00.000Z"
    );
  });
});
