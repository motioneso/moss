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
  it("says why Save is off when an entry amount is zero or negative", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } }, true);
    await f.fill();
    const amount = (value: string) =>
      act(async () => f.field("Transaction amount").props.onChange({ target: { value } }));
    const reason = "Enter an amount above zero. For a refund, set Direction to Money in / refund.";
    expect(f.button("Save transaction").props.disabled).toBe(false);
    expect(JSON.stringify(rendered!.toJSON())).not.toContain(reason);
    for (const gone of ["does not move bank money", "Money out reduces this account balance"])
      expect(JSON.stringify(rendered!.toJSON())).not.toContain(gone);
    for (const value of ["-25", "0", "0.00"]) {
      await amount(value);
      expect(f.button("Save transaction").props.disabled).toBe(true);
      expect(JSON.stringify(rendered!.toJSON())).toContain(reason);
    }
    await amount("25");
    expect(f.button("Save transaction").props.disabled).toBe(false);
    expect(JSON.stringify(rendered!.toJSON())).not.toContain(reason);
  });
  it("still accepts a zero or negative opening balance on a new account", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } });
    await f.fill();
    for (const value of ["0", "-5"]) {
      await act(async () => f.field("Opening balance").props.onChange({ target: { value } }));
      expect(f.button("Add account").props.disabled).toBe(false);
      expect(JSON.stringify(rendered!.toJSON())).not.toContain("Enter an amount above zero");
    }
  });
  it("opens without explanatory captions or a purpose subtitle", async () => {
    const account = await form({ status: "succeeded", result: { status: "ok" } });
    const text = JSON.stringify(rendered!.toJSON());
    for (const gone of [
      "Keep an account in Moss",
      "Opening balances do not count",
      "Manual accounts are currently private"
    ])
      expect(text).not.toContain(gone);
    expect(account.field("Account name")).toBeDefined();
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
