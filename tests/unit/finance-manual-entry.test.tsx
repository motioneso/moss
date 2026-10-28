// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import { ManualEntryDialog } from "../../external-modules/finance/src/web/manual-entry";

const setup: ModuleToolOutcome = {
  status: "succeeded",
  result: { status: "ok", today: "2026-10-28", supported: true, categories: [] }
};
let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
});
async function form(outcome?: ModuleToolOutcome, entry = false) {
  const invoke = vi.fn(async (tool: string) =>
    tool === "finance.manual.context" ? setup : outcome!
  );
  const onSaved = vi.fn();
  await act(async () => {
    rendered = create(
      createElement(ManualEntryDialog, {
        ...(outcome ? { tools: { invoke } } : {}),
        ...(entry
          ? {
              account: {
                accountId: "cash",
                name: "Synthetic cash",
                type: "other",
                isoCurrency: "USD",
                openingDate: "2026-10-01"
              }
            }
          : {}),
        onClose: vi.fn(),
        onSaved
      })
    );
  });
  const field = (label: string) => rendered!.root.findByProps({ "aria-label": label });
  const button = (label: string) =>
    rendered!.root.findAllByType("button").find((b) => b.children.includes(label))!;
  const fill = async () =>
    act(async () => {
      field(entry ? "Payee" : "Account name").props.onChange({
        target: { value: "Synthetic entry" }
      });
      field(entry ? "Transaction amount" : "Opening balance").props.onChange({
        target: { value: "1.23" }
      });
    });
  return { invoke, onSaved, field, button, fill };
}
describe("manual ledger forms", () => {
  it("explains an old host and keeps entry controls unavailable", async () => {
    const f = await form();
    expect(JSON.stringify(rendered!.toJSON())).toContain("Update Moss");
    expect(f.field("Account name").props.disabled).toBe(true);
    expect(f.button("Add account").props.disabled).toBe(true);
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("keeps a rejected draft editable with the same operation identity", async () => {
    const f = await form({ status: "rejected", moduleCode: "future_date" });
    await f.fill();
    await act(async () => f.button("Add account").props.onClick());
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(f.field("Account name").props.value).toBe("Synthetic entry");
    expect(f.field("Account name").props.disabled).toBe(false);
    await act(async () => f.button("Add account").props.onClick());
    const writes = f.invoke.mock.calls.filter(
      (call) => call[0] === "finance.manual.account-create"
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
  });
  it("freezes an ambiguous save and offers a records check without automatic retry", async () => {
    const f = await form({ status: "failed" }, true);
    await f.fill();
    await act(async () => f.button("Save transaction").props.onClick());
    expect(f.field("Payee").props.value).toBe("Synthetic entry");
    expect(f.field("Payee").props.disabled).toBe(true);
    expect(f.button("Check saved records")).toBeDefined();
    expect(f.button("Save transaction")).toBeUndefined();
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.onSaved).not.toHaveBeenCalled();
  });
  it("sends exact cents and explicit cleared state then closes only on committed success", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } }, true);
    await f.fill();
    await act(async () => f.button("Save transaction").props.onClick());
    expect(f.invoke).toHaveBeenLastCalledWith(
      "finance.manual.entry-create",
      expect.objectContaining({
        amountCents: 123,
        date: "2026-10-28",
        cleared: false,
        isoCurrency: "USD"
      })
    );
    expect(f.onSaved).toHaveBeenCalledTimes(1);
  });
});
