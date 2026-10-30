// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import { MerchantRuleDialog } from "../../external-modules/finance/src/web/merchant-rule-dialog";
import { MerchantRulesSection } from "../../external-modules/finance/src/web/merchant-rules";
import { invokeTool } from "../../external-modules/finance/src/web/api";
vi.mock("../../external-modules/finance/src/web/api", () => ({ invokeTool: vi.fn() }));
const categories = [
  { id: "groceries", name: "Groceries" },
  { id: "dining", name: "Dining" }
];
const rule = {
  id: "a".repeat(32),
  payeeKey: "synthetic shop",
  categoryId: "groceries",
  enabled: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  writeRevision: "b".repeat(32)
};
const preview = {
  payeeKey: rule.payeeKey,
  month: "2026-10",
  total: 0,
  limit: 20,
  existing: null,
  examples: []
};
const button = (r: ReactTestRenderer, label: string) =>
  r.root.findAllByType("button").find((b) => b.children.join("") === label)!;
async function dialog(outcome: ModuleToolOutcome, existing = true) {
  vi.mocked(invokeTool)
    .mockReset()
    .mockResolvedValue({ kind: "ok", result: { ...preview, existing: existing ? rule : null } });
  const props = {
    rule: existing ? rule : null,
    categories,
    tools: { invoke: vi.fn(async () => outcome) },
    onSaved: vi.fn(),
    onClose: vi.fn(),
    onUncertain: vi.fn()
  };
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(createElement(MerchantRuleDialog, props));
  });
  if (!existing)
    await act(async () => {
      r.root
        .findByProps({ "aria-label": "Merchant match" })
        .props.onChange({ currentTarget: { value: "Synthetic Shop #123" } });
      r.root
        .findByProps({ "aria-label": "Rule category" })
        .props.onChange({ currentTarget: { value: "dining" } });
    });
  return { r, props };
}
const review = async (r: ReactTestRenderer) => {
  await act(async () => button(r, "Preview matching history").props.onClick());
  await act(async () => button(r, "Review rule").props.onClick());
};
describe("merchant rule captured review", () => {
  it("requires a normalization preview and retains a captured create after cancellation and background changes", async () => {
    const { r, props } = await dialog({ status: "cancelled" }, false);
    expect(button(r, "Review rule").props.disabled).toBe(true);
    await review(r);
    await act(async () =>
      r.update(
        createElement(MerchantRuleDialog, {
          ...props,
          rule: { ...rule, writeRevision: "c".repeat(32) },
          categories: [{ id: "dining", name: "Renamed" }]
        })
      )
    );
    await act(async () => button(r, "Confirm rule").props.onClick());
    expect(props.tools.invoke).toHaveBeenCalledWith("finance.rules.update", {
      merchant: "Synthetic Shop #123",
      categoryId: "dining",
      enabled: true
    });
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toContain("synthetic shop · Dining");
    expect(JSON.stringify(r.toJSON())).toContain("Cancelled. Your captured rule review is kept.");
    await act(async () => r.unmount());
  });
  it("retains the original revision, suppresses immediate duplicates/dismissal and waits for persistence", async () => {
    const { r, props } = await dialog({ status: "cancelled" });
    await review(r);
    await act(async () =>
      r.update(
        createElement(MerchantRuleDialog, {
          ...props,
          rule: { ...rule, writeRevision: "c".repeat(32) }
        })
      )
    );
    let finish!: (outcome: ModuleToolOutcome) => void;
    props.tools.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => {
      const submit = button(r, "Confirm rule").props.onClick;
      submit();
      submit();
      button(r, "Back to rules").props.onClick();
    });
    expect(props.tools.invoke).toHaveBeenCalledOnce();
    expect(props.tools.invoke).toHaveBeenCalledWith("finance.rules.update", {
      merchant: rule.payeeKey,
      categoryId: rule.categoryId,
      enabled: true,
      expectedRevision: rule.writeRevision
    });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSaved).not.toHaveBeenCalled();
    await act(async () => finish({ status: "succeeded", result: { status: "ok" } }));
    expect(props.onSaved).toHaveBeenCalledOnce();
    await act(async () => r.unmount());
  });
  it.each([{ status: "failed" }, { status: "rejected", moduleCode: "stale_rules" }] as const)(
    "blocks stale or ambiguous outcomes without retries",
    async (outcome) => {
      const { r, props } = await dialog(outcome);
      await review(r);
      await act(async () => button(r, "Confirm rule").props.onClick());
      expect(button(r, "Confirm rule").props.disabled).toBe(true);
      await act(async () => button(r, "Confirm rule").props.onClick());
      expect(props.tools.invoke).toHaveBeenCalledOnce();
      expect(props.onUncertain).toHaveBeenCalledOnce();
      expect(props.onSaved).not.toHaveBeenCalled();
      expect(invokeTool).toHaveBeenCalledOnce();
      await act(async () => r.unmount());
    }
  );
  it("refuses to create over a rule already found in the read-only preview", async () => {
    const { r, props } = await dialog({ status: "cancelled" }, false);
    vi.mocked(invokeTool).mockResolvedValue({ kind: "ok", result: { ...preview, existing: rule } });
    await act(async () => button(r, "Preview matching history").props.onClick());
    expect(button(r, "Review rule").props.disabled).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain("This merchant already has a rule.");
    expect(props.tools.invoke).not.toHaveBeenCalled();
    await act(async () => r.unmount());
  });
});
describe("merchant rule loading", () => {
  it("honors the server wait and performs another read only after an explicit retry", async () => {
    vi.useFakeTimers();
    let r: ReactTestRenderer | undefined;
    try {
      vi.mocked(invokeTool)
        .mockReset()
        .mockResolvedValue({ kind: "error", message: "Synthetic busy read", retryAfterSeconds: 5 });
      await act(async () => {
        r = create(createElement(MerchantRulesSection, { tools: { invoke: vi.fn() } }));
      });
      expect(button(r!, "Wait before checking rules").props.disabled).toBe(true);
      expect(button(r!, "Search rules").props.disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(invokeTool).toHaveBeenCalledOnce();
      expect(button(r!, "Check saved rules").props.disabled).toBe(false);
      vi.mocked(invokeTool).mockResolvedValue({
        kind: "ok",
        result: { supported: true, ready: true, rules: [], categories, total: 0, limit: 50 }
      });
      await act(async () => button(r!, "Check saved rules").props.onClick());
      expect(invokeTool).toHaveBeenCalledTimes(2);
      expect(button(r!, "Add merchant rule").props.disabled).toBe(false);
    } finally {
      if (r) await act(async () => r!.unmount());
      vi.useRealTimers();
    }
  });
  it("preserves a loaded view on read failure and keeps edits unavailable until a successful check", async () => {
    const tools = { invoke: vi.fn() };
    const data = { supported: true, ready: true, rules: [rule], categories, total: 1, limit: 50 };
    vi.mocked(invokeTool).mockReset().mockResolvedValue({ kind: "ok", result: data });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(createElement(MerchantRulesSection, { tools }));
    });
    expect(button(r, "Add merchant rule").props.disabled).toBe(false);
    vi.mocked(invokeTool).mockResolvedValue({ kind: "error", message: "Synthetic read failure" });
    await act(async () => button(r, "Check saved rules").props.onClick());
    expect(JSON.stringify(r.toJSON())).toContain(rule.payeeKey);
    expect(button(r, "Add merchant rule").props.disabled).toBe(true);
    vi.mocked(invokeTool).mockResolvedValue({ kind: "ok", result: data });
    await act(async () => button(r, "Check saved rules").props.onClick());
    expect(button(r, "Add merchant rule").props.disabled).toBe(false);
    await act(async () => r.unmount());
  });
  it("does not display a previous host scope's rows while the new read is pending", async () => {
    const first = { invoke: vi.fn() },
      second = { invoke: vi.fn() };
    vi.mocked(invokeTool)
      .mockReset()
      .mockResolvedValue({
        kind: "ok",
        result: { supported: true, ready: true, rules: [rule], categories, total: 1, limit: 50 }
      });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(createElement(MerchantRulesSection, { tools: first }));
    });
    let finish!: (value: Awaited<ReturnType<typeof invokeTool>>) => void;
    vi.mocked(invokeTool).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => r.update(createElement(MerchantRulesSection, { tools: second })));
    expect(JSON.stringify(r.toJSON())).not.toContain(rule.payeeKey);
    await act(async () =>
      finish({
        kind: "ok",
        result: { supported: true, ready: true, rules: [], categories, total: 0, limit: 50 }
      })
    );
    expect(JSON.stringify(r.toJSON())).toContain("No merchant rules yet.");
    await act(async () => r.unmount());
  });
});
