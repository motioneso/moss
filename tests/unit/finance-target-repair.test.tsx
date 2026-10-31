// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { BudgetTargets } from "../../external-modules/finance/src/web/budget-targets";
import {
  targetRemoveHandler,
  targetSetHandler
} from "../../external-modules/finance/src/worker/handlers/targets.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { FLEX_POOL } from "../../external-modules/finance/src/domain/flex.js";
import type { TargetProgress } from "../../external-modules/finance/src/domain/targets.js";
const tokens = { expectedRevision: 1, expectedFingerprint: "a".repeat(32) };
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name))!;
describe("legacy target repair", () => {
  it("removes pooled target metadata through its own tool and rejects new pooled targets", async () => {
    const save = vi.fn(async () => true);
    const ports = {
      store: async () => ({
        budgetPolicy: {
          get: async () => ({
            revision: 1,
            fingerprint: "a".repeat(32),
            taxonomyReady: true,
            isoCurrency: "USD"
          })
        },
        flex: {
          policies: async () => [
            { month: "2026-10", active: true, flexIds: ["savings"], nonMonthlyIds: [] }
          ]
        },
        targets: { save }
      }),
      now: () => new Date("2026-10-30T12:00:00Z")
    } as unknown as WorkerPorts;
    expect(
      await targetRemoveHandler(ports)({ ...tokens, month: "2026-10", categoryId: "savings" })
    ).toMatchObject({ status: "ok" });
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: "savings",
        effectiveMonth: "2026-10",
        kind: "removed",
        amountCents: 0
      }),
      { revision: 1, fingerprint: "a".repeat(32) },
      expect.any(String)
    );
    const set = targetSetHandler(ports);
    await expect(
      set({ ...tokens, month: "2026-10", categoryId: "savings", kind: "monthly", amountCents: 100 })
    ).rejects.toThrow(/pool/i);
    await expect(
      set({ ...tokens, month: "2026-10", categoryId: "savings", kind: "removed", amountCents: 0 })
    ).rejects.toThrow();
    expect(save).toHaveBeenCalledOnce();
  });
  it("names a legacy pooled target, excludes the synthetic pool and offers confirm-first removal without ordinary edits", async () => {
    const target: TargetProgress = {
      categoryId: "savings",
      effectiveMonth: "2026-10",
      kind: "monthly",
      amountCents: 100,
      dueDate: null,
      progressCents: 0,
      remainingCents: 100,
      suggestedCents: 100,
      status: "in-progress"
    };
    const invoke = vi.fn(async () => ({ status: "cancelled" as const }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(BudgetTargets, {
          month: "2026-10",
          currency: "USD",
          revision: 1,
          fingerprint: "a".repeat(32),
          categories: [
            { id: FLEX_POOL, name: "Flexible spending" },
            { id: "rent", name: "Rent" }
          ],
          targets: [target],
          tools: { invoke },
          funding: {
            currentMonth: "2026-10",
            readyCents: 10000,
            lines: [
              {
                categoryId: "savings",
                name: "Old savings",
                kind: "monthly",
                dueDate: null,
                amountCents: 100,
                previousCents: 0,
                newAssignedCents: 100,
                unavailableReason: "pooled"
              }
            ]
          }
        })
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Old savings");
    await act(async () => button(renderer, "Review old target").props.onClick());
    const options = renderer.root.findAllByType("option");
    expect(options.some((o) => o.props.value === FLEX_POOL)).toBe(false);
    expect(options.find((o) => o.props.value === "savings")?.children.join(" ")).toContain(
      "Old savings"
    );
    expect(button(renderer, "Save target").props.disabled).toBe(true);
    expect(button(renderer, "Remove target").props.disabled).toBe(false);
    expect(renderer.root.findByProps({ "aria-label": "Target amount" }).props.disabled).toBe(true);

    await act(async () => button(renderer, "Remove target").props.onClick());
    expect(invoke).toHaveBeenCalledWith("finance.target.remove", {
      month: "2026-10",
      categoryId: "savings",
      ...tokens
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Cancelled. The target is kept.");
  });
  it("labels the pending removal on the Remove button, not on Save", async () => {
    const target: TargetProgress = {
      categoryId: "rent",
      effectiveMonth: "2026-10",
      kind: "monthly",
      amountCents: 15000,
      dueDate: null,
      progressCents: 0,
      remainingCents: 15000,
      suggestedCents: 15000,
      status: "in-progress"
    };
    let settle!: (outcome: { status: "cancelled" }) => void;
    const invoke = vi.fn(
      () => new Promise<{ status: "cancelled" }>((resolve) => (settle = resolve))
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(BudgetTargets, {
          month: "2026-10",
          currency: "USD",
          revision: 1,
          fingerprint: "a".repeat(32),
          categories: [{ id: "rent", name: "Rent" }],
          targets: [target],
          tools: { invoke }
        })
      );
    });
    await act(async () => button(renderer, "Edit target").props.onClick());
    await act(async () => {
      button(renderer, "Remove target").props.onClick();
    });
    expect(button(renderer, "Removing…").props.disabled).toBe(true);
    expect(button(renderer, "Save target").props.disabled).toBe(true);
    await act(async () => settle({ status: "cancelled" }));
    expect(button(renderer, "Remove target").props.disabled).toBe(false);
  });
});
