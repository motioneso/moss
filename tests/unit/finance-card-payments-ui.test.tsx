// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import { CardPayments } from "../../external-modules/finance/src/web/card-payments";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name))!;
const payment = {
  accountId: "card",
  startingDebtCents: 50000,
  owedCents: 50000,
  assignedCents: 10000,
  fundedCents: 0,
  refundsCents: 0,
  paymentsCents: 0,
  unfundedCents: 0,
  availableCents: 10000
};
const preview = {
  status: "ok",
  revision: 5,
  fingerprint: "a".repeat(32),
  readyBeforeCents: 50000,
  readyAfterCents: 90000,
  payment
};
async function setup(outcome: ModuleToolOutcome = { status: "cancelled" }) {
  const invoke = vi.fn(
    async (name: string): Promise<ModuleToolOutcome> =>
      name.endsWith("preview") ? { status: "succeeded", result: preview } : outcome
  );
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      createElement(CardPayments, {
        data: {
          month: "2026-10",
          currentMonth: "2026-10",
          isoCurrency: "USD",
          cardPayments: [],
          cardChoices: [{ accountId: "card", name: "Synthetic card" }]
        },
        tools: { invoke }
      })
    );
  });
  await act(async () => button(r, "Set up payment reserve").props.onClick());
  const input = () => r.root.findByType("input");
  const change = (value: string) =>
    act(async () => input().props.onChange({ currentTarget: { value } }));
  return { r, invoke, input, change };
}
describe("captured card-payment cash review", () => {
  it("keeps cancelled review and inputs, binds the exact preview tokens, and invalidates edited amounts", async () => {
    const { r, invoke, input, change } = await setup();
    await change("100.00");
    expect(button(r, "Confirm payment cash").props.disabled).toBe(true);
    await act(async () => button(r, "Review amounts").props.onClick());
    await act(async () => button(r, "Confirm payment cash").props.onClick());
    expect(invoke).toHaveBeenLastCalledWith("finance.card-reserve.save", {
      month: "2026-10",
      accountId: "card",
      action: "enroll",
      availableCents: 10000,
      expectedRevision: 5,
      expectedFingerprint: "a".repeat(32)
    });
    expect(input().props.value).toBe("100.00");
    expect(JSON.stringify(r.toJSON())).toContain("Nothing saved. Your review is still here.");
    await change("99.99");
    expect(button(r, "Confirm payment cash").props.disabled).toBe(true);
    await act(async () => r.unmount());
  });
  it.each([
    { status: "failed" },
    { status: "rejected", moduleCode: "stale_budget" }
  ] as ModuleToolOutcome[])(
    "blocks uncertain/stale writes without retries: %j",
    async (outcome) => {
      const { r, invoke, input } = await setup(outcome);
      await act(async () => button(r, "Review amounts").props.onClick());
      await act(async () => button(r, "Confirm payment cash").props.onClick());
      expect(button(r, "Confirm payment cash").props.disabled).toBe(true);
      expect(button(r, "Review amounts").props.disabled).toBe(true);
      expect(input().props.disabled).toBe(true);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(r.toJSON())).toContain("check saved records");
      await act(async () => r.unmount());
    }
  );
  it("reviews exact safe-integer amounts without the ordinary category assignment cap", async () => {
    const { r, invoke, change } = await setup();
    await change("90071992547409.90");
    await act(async () => button(r, "Review amounts").props.onClick());
    expect(invoke).toHaveBeenCalledWith("finance.card-reserve.preview", {
      month: "2026-10",
      accountId: "card",
      action: "enroll",
      availableCents: Number.MAX_SAFE_INTEGER - 1
    });
    await act(async () => r.unmount());
  });
  it("preserves the last cent when opening an existing large payment reserve", async () => {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(
        createElement(CardPayments, {
          data: {
            month: "2026-10",
            currentMonth: "2026-10",
            isoCurrency: "USD",
            cardPayments: [
              {
                ...payment,
                name: "Synthetic card",
                archived: false,
                availableCents: Number.MAX_SAFE_INTEGER - 1
              }
            ],
            cardChoices: []
          },
          tools: { invoke: vi.fn() }
        })
      );
    });
    await act(async () => button(r, "Review payment cash").props.onClick());
    expect(r.root.findByType("input").props.value).toBe("90071992547409.90");
    await act(async () => r.unmount());
  });
  it("rejects sub-cent amounts before invoking a tool", async () => {
    const { r, invoke, change } = await setup();
    await change("12.345");
    await act(async () => button(r, "Review amounts").props.onClick());
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toContain("two decimal places");
    await act(async () => r.unmount());
  });
});
