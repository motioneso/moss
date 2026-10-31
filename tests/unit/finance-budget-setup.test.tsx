// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import { BudgetSetup, recordedAmount } from "../../external-modules/finance/src/web/budget-setup";
let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
});
async function form(outcome?: ModuleToolOutcome, legacy = 0) {
  const invoke = vi.fn(async () => outcome!);
  await act(async () => {
    rendered = create(
      createElement(BudgetSetup, {
        ...(outcome ? { tools: { invoke } } : {}),
        storageReady: true,
        legacyMonthCount: legacy,
        legacyMonths: legacy ? [{ month: "2026-01", totalCents: "12345" }] : [],
        currencies: ["USD", "EUR"],
        accountCurrencies: ["EUR", "USD"]
      })
    );
  });
  const select = () => rendered!.root.findByProps({ "aria-label": "Budget currency" });
  const save = () =>
    rendered!.root.findAllByType("button").find((b) => b.children.includes("Set currency"))!;
  return { invoke, select, save };
}
describe("budget currency review", () => {
  it("never preselects a currency, requires legacy acknowledgement and retains a cancelled choice", async () => {
    const f = await form({ status: "cancelled" }, 1);
    expect(f.select().props.value).toBe("");
    expect(f.save().props.disabled).toBe(true);
    expect(JSON.stringify(rendered!.toJSON())).toContain("123.45");
    await act(async () => f.select().props.onChange({ currentTarget: { value: "EUR" } }));
    expect(f.save().props.disabled).toBe(true);
    const toggle = rendered!.root
      .findAllByProps({ "aria-label": "Acknowledge existing assignments" })
      .find((node) => node.type === "input")!;
    await act(async () => toggle.props.onChange({ target: { checked: true } }));
    await act(async () => f.save().props.onClick());
    expect(f.invoke).toHaveBeenCalledWith("finance.budget.configure", {
      isoCurrency: "EUR",
      acknowledgeLegacy: true
    });
    expect(f.select().props.value).toBe("EUR");
    expect(JSON.stringify(rendered!.toJSON())).toContain("Cancelled");
  });
  it("explains a missing host bridge and prevents writes", async () => {
    const f = await form();
    expect(f.save().props.disabled).toBe(true);
    expect(JSON.stringify(rendered!.toJSON())).toContain("Update Moss");
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
describe("recorded monthly totals", () => {
  it("reads whole cents in the browser's own grouping and decimal mark, at any size", () => {
    expect(recordedAmount("123456", "en-US")).toBe("1,234.56");
    expect(recordedAmount("123456", "de-DE")).toBe("1.234,56");
    expect(recordedAmount("-5", "en-US")).toBe("\u22120.05");
    expect(recordedAmount("9007199254740993", "en-US")).toBe("90,071,992,547,409.93");
  });
});
