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
  vi.useRealTimers();
});
type Instance = ReactTestRenderer["root"];
type Read = (args: Record<string, unknown>) => ModuleToolOutcome | Promise<ModuleToolOutcome>;
const innerText = (node: Instance | string): string =>
  typeof node === "string" ? node : node.children.map(innerText).join("");
const readOutcome = (
  rows: ReconciliationView,
  statementDate = "2026-10-28"
): ModuleToolOutcome => ({
  status: "succeeded",
  result: { status: "ok", statementDate, today: "2026-10-28", view: rows }
});
// Answers the way the server does: the review is for the date that was asked for.
const echoRead =
  (rows: ReconciliationView): Read =>
  (args) =>
    readOutcome(rows, typeof args.statementDate === "string" ? args.statementDate : undefined);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function render(
  result: ModuleToolOutcome,
  rows = view,
  read: Read = () => readOutcome(rows)
) {
  const invoke = vi.fn(async (tool: string, args: Record<string, unknown>) =>
    tool.endsWith(".read") ? read(args) : result
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
  // The balance input is named by its visible label, so it carries no aria-label of its own.
  const field = () => rendered!.root.findByProps({ inputMode: "decimal" });
  const dateField = () => rendered!.root.findByProps({ "aria-label": "Statement date" });
  const fill = async (value: string) =>
    act(async () => field().props.onChange({ target: { value } }));
  const type = async (value: string) =>
    act(async () => dateField().props.onChange({ target: { value } }));
  const blur = async () => act(async () => dateField().props.onBlur());
  const reads = () => invoke.mock.calls.filter(([tool]) => tool.endsWith(".read"));
  const visible = () => innerText(rendered!.root);
  return { invoke, onSaved, finish, field, dateField, fill, type, blur, reads, visible };
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
describe("statement fields", () => {
  const finished: ModuleToolOutcome = { status: "succeeded", result: { status: "ok" } };
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wait = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });
  // Every read for a chosen date waits on the returned promise.
  const heldReads = () => {
    const held = deferred<ModuleToolOutcome>();
    const read: Read = (args) => (args.statementDate ? held.promise : readOutcome(view));
    return { held, read };
  };

  it.each([
    ["a cash account", view, "Statement balance (USD)"],
    ["a debt account", { ...view, debt: true }, "Amount owed on statement (USD)"]
  ])("names the balance field of %s by its visible label", async (_kind, rows, label) => {
    const f = await render(finished, rows);
    expect(f.field().props["aria-label"]).toBeUndefined();
    const wrapper = rendered!.root
      .findAllByType("label")
      .find((candidate) =>
        candidate.findAllByType("input").some((input) => input.props.inputMode === "decimal")
      );
    expect(wrapper && innerText(wrapper)).toBe(label);
  });

  it("shows every date in words", async () => {
    const f = await render(finished);
    expect(f.visible()).toContain("Opening baseline: Oct 1, 2026.");
    expect(f.visible()).toContain("2 unreconciled entries through Oct 28, 2026.");
    expect(f.visible()).toContain("Oct 5, 2026 · Money out · $10.00");
    expect(f.visible()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("reads another statement date once typing pauses", async () => {
    fakeTimers();
    const f = await render(finished, view, echoRead(view));
    expect(f.reads()).toHaveLength(1);
    await f.type("2026-10-20");
    await wait(599);
    expect(f.reads()).toHaveLength(1);
    await f.type("2026-10-21");
    await wait(599);
    expect(f.reads()).toHaveLength(1);
    await wait(1);
    expect(f.reads()).toHaveLength(2);
    expect(f.reads()[1]![1]).toEqual({ accountId: "cash", statementDate: "2026-10-21" });
    expect(f.dateField().props.value).toBe("2026-10-21");
    expect(f.visible()).toContain("through Oct 21, 2026");
  });

  it("reads at once when the date field loses focus", async () => {
    fakeTimers();
    const f = await render(finished, view, echoRead(view));
    await f.type("2026-10-20");
    await f.blur();
    expect(f.reads()).toHaveLength(2);
    expect(f.reads()[1]![1]).toEqual({ accountId: "cash", statementDate: "2026-10-20" });
    await wait(5000);
    expect(f.reads()).toHaveLength(2);
  });

  it.each([
    ["before the account opened", "2026-09-30"],
    ["after today", "2026-10-29"],
    ["with a partly typed year", "0002-10-28"],
    ["that is not a real day", "2026-02-30"]
  ])("never reads a date %s", async (_why, value) => {
    fakeTimers();
    const f = await render(finished, view, echoRead(view));
    await f.fill("90.00");
    expect(f.finish().props.disabled).toBe(false);
    await f.type(value);
    await f.blur();
    await wait(5000);
    expect(f.reads()).toHaveLength(1);
    expect(f.finish().props.disabled).toBe(true);
  });

  it("keeps Finish off until the review for the typed date has loaded", async () => {
    fakeTimers();
    const { held, read } = heldReads();
    const f = await render(finished, view, read);
    await f.fill("90.00");
    expect(f.finish().props.disabled).toBe(false);
    await f.type("2026-10-20");
    expect(f.finish().props.disabled).toBe(true);
    await f.blur();
    expect(f.visible()).toContain("Loading statement entries");
    expect(f.finish().props.disabled).toBe(true);
    await act(async () => held.resolve(readOutcome(view, "2026-10-20")));
    expect(f.finish().props.disabled).toBe(false);
    await act(async () => f.finish().props.onClick());
    expect(f.invoke).toHaveBeenLastCalledWith(
      "finance.reconciliation.finish",
      expect.objectContaining({ statementDate: "2026-10-20", balanceCents: 9000 })
    );
  });

  it("keeps the date and balance fields editable while a statement loads", async () => {
    fakeTimers();
    const { read } = heldReads();
    const f = await render(finished, view, read);
    await f.type("2026-10-20");
    await f.blur();
    expect(f.visible()).toContain("Loading statement entries");
    expect(f.dateField().props.disabled).toBe(false);
    expect(f.field().props.disabled).toBe(false);
  });

  it("keeps a date typed while an earlier read is still running", async () => {
    fakeTimers();
    const held = deferred<ModuleToolOutcome>();
    const f = await render(finished, view, (args) =>
      args.statementDate === "2026-10-20" ? held.promise : echoRead(view)(args)
    );
    await f.fill("90.00");
    await f.type("2026-10-20");
    await f.blur();
    await f.type("2026-10-22");
    await act(async () => held.resolve(readOutcome(view, "2026-10-20")));
    expect(f.dateField().props.value).toBe("2026-10-22");
    expect(f.visible()).toContain("through Oct 20, 2026");
    expect(f.finish().props.disabled).toBe(true);
    await wait(600);
    expect(f.reads().at(-1)![1]).toEqual({ accountId: "cash", statementDate: "2026-10-22" });
    expect(f.dateField().props.value).toBe("2026-10-22");
    expect(f.visible()).toContain("through Oct 22, 2026");
  });
});
