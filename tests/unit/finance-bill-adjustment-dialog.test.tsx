// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { BillAdjustmentDialog } from "../../external-modules/finance/src/web/bill-adjustment-dialog";
import type {
  BillsView,
  Occurrence
} from "../../external-modules/finance/src/web/screens/upcoming";
const occurrence: Occurrence = {
  planId: "synthetic-plan",
  name: "Synthetic bill",
  accountId: "cash",
  categoryId: "utilities",
  dueDate: "2026-01-31",
  plannedDate: "2026-02-03",
  expectedCents: 10001,
  adjusted: true,
  canAdjust: true,
  state: "projected",
  actualCents: null,
  transactionId: null
};
const data: BillsView = {
  today: "2026-10-30",
  isoCurrency: "USD",
  revision: 1,
  fingerprint: "a".repeat(32),
  plans: [
    {
      id: occurrence.planId,
      name: occurrence.name,
      accountId: "cash",
      categoryId: "utilities",
      isoCurrency: "USD",
      amountCents: 10000,
      anchorDate: occurrence.dueDate,
      cadence: "monthly"
    }
  ],
  occurrences: [occurrence],
  accounts: [],
  categories: [],
  transactions: []
};
async function render(invoke: ExternalModuleToolsHandleV1["invoke"], reset = false) {
  let renderer!: ReactTestRenderer;
  const props = {
    data,
    occurrence,
    reset,
    tools: { invoke },
    onClose: vi.fn(),
    onUncertain: vi.fn()
  };
  await act(async () => {
    renderer = create(createElement(BillAdjustmentDialog, props));
  });
  return { renderer, props };
}
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name))!;
async function fill(r: ReactTestRenderer, label: string, value: string) {
  await act(async () =>
    r.root.findByProps({ "aria-label": label }).props.onChange({ currentTarget: { value } })
  );
}
async function capture(r: ReactTestRenderer) {
  await fill(r, "Occurrence expected amount", "100.02");
  await act(async () => button(r, "Review bill change").props.onClick());
}
describe("captured one-off bill review", () => {
  it("retains exact cents and the original review across host cancellation and rerenders", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer, props } = await render(invoke);
    await capture(renderer);
    await act(async () =>
      renderer.update(
        createElement(BillAdjustmentDialog, {
          ...props,
          data: { ...data, revision: 9, fingerprint: "b".repeat(32) },
          occurrence: { ...occurrence, dueDate: "2026-03-31" }
        })
      )
    );
    await act(async () => button(renderer, "Confirm bill change").props.onClick());
    expect(invoke).toHaveBeenLastCalledWith("finance.bill.adjust", {
      planId: occurrence.planId,
      dueDate: "2026-01-31",
      plannedDate: "2026-02-03",
      amountCents: 10002,
      expectedRevision: 1,
      expectedFingerprint: "a".repeat(32)
    });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onUncertain).not.toHaveBeenCalled();
    await act(async () => button(renderer, "Confirm bill change").props.onClick());
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
  });
  it.each(["0", "-1", "1.001", "1000000.01"])(
    "does not prepare invalid amounts (%s)",
    async (amount) => {
      const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
      const { renderer } = await render(invoke);
      await fill(renderer, "Occurrence expected amount", amount);
      expect(button(renderer, "Review bill change").props.disabled).toBe(true);
      await act(async () => button(renderer, "Review bill change").props.onClick());
      expect(invoke).not.toHaveBeenCalled();
    }
  );
  it("blocks uncertain writes while preserving the captured projection", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    const { renderer, props } = await render(invoke);
    await capture(renderer);
    await act(async () => button(renderer, "Confirm bill change").props.onClick());
    expect(button(renderer, "Confirm bill change").props.disabled).toBe(true);
    await act(async () => button(renderer, "Confirm bill change").props.onClick());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(props.onUncertain).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("suppresses duplicate submissions and dismissal before React paints busy state", async () => {
    let resolve!: (result: ModuleToolOutcome) => void;
    const invoke = vi.fn(
      () =>
        new Promise<ModuleToolOutcome>((done) => {
          resolve = done;
        })
    );
    const { renderer, props } = await render(invoke);
    await capture(renderer);
    const save = button(renderer, "Confirm bill change").props.onClick;
    const cancel = button(renderer, "Cancel").props.onClick;
    await act(async () => {
      void save();
      void save();
      cancel();
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve({ status: "succeeded", result: { status: "ok" } }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("resets through its dedicated confirmed tool using the stable original identity", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer } = await render(invoke, true);
    await act(async () => button(renderer, "Confirm reset").props.onClick());
    expect(invoke).toHaveBeenCalledWith("finance.bill.adjust-reset", {
      planId: occurrence.planId,
      dueDate: "2026-01-31",
      expectedRevision: 1,
      expectedFingerprint: "a".repeat(32)
    });
  });
});
