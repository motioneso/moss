// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import {
  reconciledSelectionBalance,
  type ReconciliationView
} from "../../external-modules/finance/src/domain/reconciliation";
import { ReconciliationDialog } from "../../external-modules/finance/src/web/reconciliation-dialog";
import { reconciliationFinishHandler } from "../../external-modules/finance/src/worker/handlers/reconciliation";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports";

const view: ReconciliationView = {
  accountId: "cash",
  name: "Synthetic cash",
  isoCurrency: "USD",
  debt: false,
  openingDate: "2026-10-01",
  lastReconciledDate: null,
  revision: 2,
  baselineCents: 10000,
  recordedCents: 9500,
  totalEntries: 2,
  entries: [
    { id: "spend", date: "2026-10-05", name: "Synthetic shop", amountCents: 1000, cleared: true },
    {
      id: "refund",
      date: "2026-10-06",
      name: "Synthetic refund",
      amountCents: -500,
      cleared: false
    }
  ]
};
describe("statement calculations and validation", () => {
  it("keeps outstanding entries out, applies refunds and reverses debt signs exactly", () => {
    expect(reconciledSelectionBalance(view, new Set(["spend"]))).toBe(9000);
    expect(reconciledSelectionBalance(view, new Set(["spend", "refund"]))).toBe(9500);
    expect(reconciledSelectionBalance({ ...view, debt: true }, new Set(["spend"]))).toBe(11000);
    expect(
      reconciledSelectionBalance(
        { ...view, baselineCents: Number.MAX_SAFE_INTEGER },
        new Set(["refund"])
      )
    ).toBeNull();
  });
  it.each([
    { selectedIds: ["spend", "spend"] },
    { selectedIds: [42] },
    { selectedIds: Array.from({ length: 501 }, (_, i) => `${i}`) },
    { statementDate: "2026-02-30" },
    { statementDate: "2026-10-29" },
    { expectedRevision: -1 },
    { balanceCents: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects invalid statement input before storage: %j", async (change) => {
    const finish = vi.fn();
    const ports = {
      localTimezone: "UTC",
      now: () => new Date("2026-10-28T12:00:00Z"),
      store: async () => ({ reconciliation: { finish } })
    } as unknown as WorkerPorts;
    await expect(
      reconciliationFinishHandler(ports)({
        operationId: "10000000-0000-4000-8000-000000000001",
        accountId: "cash",
        statementDate: "2026-10-28",
        isoCurrency: "USD",
        balanceCents: 9000,
        expectedRevision: 2,
        selectedIds: ["spend"],
        ...change
      })
    ).rejects.toThrow();
    expect(finish).not.toHaveBeenCalled();
  });
});
let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
});
async function render(result: ModuleToolOutcome, rows = view) {
  const invoke = vi.fn(async (tool: string) =>
    tool.endsWith(".read")
      ? {
          status: "succeeded" as const,
          result: { status: "ok", statementDate: "2026-10-28", today: "2026-10-28", view: rows }
        }
      : result
  );
  const onSaved = vi.fn();
  await act(async () => {
    rendered = create(
      createElement(ReconciliationDialog, {
        account: { accountId: "cash", name: "Synthetic cash", isoCurrency: "USD", type: "other" },
        tools: { invoke },
        onClose: vi.fn(),
        onSaved
      })
    );
  });
  const finish = () =>
    rendered!.root
      .findAllByType("button")
      .find((b) => b.children.includes("Finish reconciliation"))!;
  const field = () => rendered!.root.findByProps({ "aria-label": "Statement balance" });
  const fill = async (value: string) =>
    act(async () => field().props.onChange({ target: { value } }));
  return { invoke, onSaved, finish, field, fill };
}
describe("statement review form", () => {
  it("requires a zero difference and sends the exact revision and selected entries", async () => {
    const f = await render({ status: "succeeded", result: { status: "ok" } });
    await f.fill("90.01");
    expect(f.finish().props.disabled).toBe(true);
    await f.fill("90.00");
    expect(f.finish().props.disabled).toBe(false);
    await act(async () => f.finish().props.onClick());
    expect(f.invoke).toHaveBeenLastCalledWith(
      "finance.reconciliation.finish",
      expect.objectContaining({ balanceCents: 9000, expectedRevision: 2, selectedIds: ["spend"] })
    );
    expect(f.onSaved).toHaveBeenCalledTimes(1);
  });
  it("keeps a stale draft and requires explicit refresh", async () => {
    const f = await render({ status: "rejected", moduleCode: "stale_reconciliation" });
    await f.fill("90.00");
    await act(async () => f.finish().props.onClick());
    expect(f.field().props.value).toBe("90.00");
    expect(f.finish().props.disabled).toBe(true);
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(JSON.stringify(rendered!.toJSON())).toContain("Refresh statement review");
  });
  it("does not finish or retry when delivery is uncertain", async () => {
    const f = await render({ status: "failed" });
    await f.fill("90.00");
    await act(async () => f.finish().props.onClick());
    expect(f.field().props.disabled).toBe(true);
    expect(f.finish().props.disabled).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.onSaved).not.toHaveBeenCalled();
  });
  it("refuses a truncated review even if its visible entries match", async () => {
    const f = await render(
      { status: "succeeded", result: { status: "ok" } },
      { ...view, totalEntries: 501 }
    );
    await f.fill("90.00");
    expect(f.finish().props.disabled).toBe(true);
    expect(JSON.stringify(rendered!.toJSON())).toContain("earlier statement date");
  });
});
