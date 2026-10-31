// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { BillPlanDialog } from "../../external-modules/finance/src/web/bill-plan-dialog";
import type { BillsView } from "../../external-modules/finance/src/web/screens/upcoming";
const data: BillsView = {
  today: "2026-10-29",
  isoCurrency: "USD",
  revision: 1,
  fingerprint: "a".repeat(32),
  plans: [],
  occurrences: [],
  accounts: [{ accountId: "cash", name: "Synthetic cash" }],
  categories: [{ id: "utilities", name: "Utilities" }],
  transactions: []
};
async function render(invoke: ExternalModuleToolsHandleV1["invoke"]) {
  let renderer!: ReactTestRenderer;
  const props = { data, tools: { invoke }, onClose: vi.fn() };
  await act(async () => {
    renderer = create(createElement(BillPlanDialog, props));
  });
  return { renderer, props };
}
async function fill(renderer: ReactTestRenderer, label: string, value: string) {
  await act(async () =>
    renderer.root.findByProps({ "aria-label": label }).props.onChange({ currentTarget: { value } })
  );
}
// The amount field is named by its visible label, so look it up the way a person reads it.
function amountField(r: ReactTestRenderer) {
  const label = r.root.findAllByType("label").find((l) =>
    l.children
      .filter((c): c is string => typeof c === "string")
      .join("")
      .startsWith("Expected amount")
  )!;
  return label.findByType("input");
}
async function fillAmount(r: ReactTestRenderer, value: string) {
  await act(async () => amountField(r).props.onChange({ currentTarget: { value } }));
}
const button = (r: ReactTestRenderer) =>
  r.root.findAllByType("button").find((b) => b.children.includes("Save bill plan"))!;
async function complete(r: ReactTestRenderer) {
  await fill(r, "Bill name", "Synthetic utilities");
  await fill(r, "Bill account", "cash");
  await fill(r, "Bill category", "utilities");
  await fillAmount(r, "123.45");
}
describe("reviewed bill plan form", () => {
  it("requires explicit account/category and keeps the review captured when opened", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer, props } = await render(invoke);
    expect(button(renderer).props.disabled).toBe(true);
    await complete(renderer);
    await act(async () =>
      renderer.update(
        createElement(BillPlanDialog, {
          ...props,
          data: { ...data, revision: 9, fingerprint: "b".repeat(32) }
        })
      )
    );
    await act(async () => button(renderer).props.onClick());
    expect(invoke).toHaveBeenCalledWith(
      "finance.bill.create",
      expect.objectContaining({
        name: "Synthetic utilities",
        amountCents: 12345,
        expectedRevision: 1,
        expectedFingerprint: "a".repeat(32)
      })
    );
    expect(renderer.root.findByProps({ "aria-label": "Bill name" }).props.value).toBe(
      "Synthetic utilities"
    );
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("blocks another write after an ambiguous response and retains entered values", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    const { renderer } = await render(invoke);
    await complete(renderer);
    await act(async () => button(renderer).props.onClick());
    expect(button(renderer).props.disabled).toBe(true);
    await act(async () => button(renderer).props.onClick());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(amountField(renderer).props.value).toBe("123.45");
    expect(amountField(renderer).props["aria-label"]).toBeUndefined();
  });
  it("rejects sub-cent input before invoking a host action", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer } = await render(invoke);
    await complete(renderer);
    await fillAmount(renderer, "1.001");
    expect(button(renderer).props.disabled).toBe(true);
    await act(async () => button(renderer).props.onClick());
    expect(invoke).not.toHaveBeenCalled();
  });
});
