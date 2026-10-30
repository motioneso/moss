// @vitest-environment jsdom
// Labeled native component fixture; real installed acceptance is tested separately.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
const invokeTool = vi.fn();
vi.mock("../../external-modules/finance/src/web/api", () => ({
  invokeTool: (...args: unknown[]) => invokeTool(...args)
}));
import { TransferCorrectionDialog } from "../../external-modules/finance/src/web/transfer-correction-dialog";
const originalId = "99000000-0000-4000-8000-000000000001";
function context() {
  return {
    status: "ok",
    supported: true,
    today: "2026-10-30",
    receipt: {
      transferId: originalId,
      fromAccountId: "cash",
      fromName: "Synthetic checking",
      toAccountId: "card",
      toName: "Synthetic card",
      date: "2026-10-28",
      amountCents: 1234,
      isoCurrency: "USD",
      sourceRevision: "a".repeat(32),
      intact: true,
      correctedBy: null,
      correctsTransferId: null
    },
    accounts: [
      {
        accountId: "cash",
        name: "Synthetic checking",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        balanceCents: 8766,
        openingDate: "2026-10-01",
        lastReconciledDate: null,
        revision: "b".repeat(32)
      },
      {
        accountId: "card",
        name: "Synthetic card",
        type: "credit",
        subtype: "card",
        isoCurrency: "USD",
        balanceCents: 3766,
        openingDate: "2026-10-01",
        lastReconciledDate: null,
        revision: "c".repeat(32)
      }
    ]
  };
}
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name));
afterEach(() => vi.clearAllMocks());
describe("native audited transfer correction review", () => {
  it("captures inverse balances and suppresses duplicate writes and dismissal before React paints", async () => {
    invokeTool.mockResolvedValue({ kind: "ok", result: context() });
    let finish!: (outcome: ModuleToolOutcome) => void;
    const invoke = vi.fn(
        () =>
          new Promise<ModuleToolOutcome>((resolve) => {
            finish = resolve;
          })
      ),
      onClose = vi.fn(),
      onSaved = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(TransferCorrectionDialog, {
          transferId: originalId,
          tools: { invoke },
          onClose,
          onSaved,
          onReview: vi.fn()
        })
      );
    });
    await act(async () => button(renderer, "Review correction")!.props.onClick());
    const shown = JSON.stringify(renderer.toJSON());
    expect(shown).toContain("$37.66");
    expect(shown).toContain("$50.00");
    expect(shown).toContain("$87.66");
    expect(shown).toContain("$100.00");
    const save = button(renderer, "Confirm correction")!.props.onClick,
      close = renderer.root.findByProps({ "aria-label": "Close transfer review" }).props.onClick;
    await act(async () => {
      void save();
      void save();
      close();
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("finance.manual.transfer-reverse", {
      operationId: expect.any(String),
      originalTransferId: originalId,
      sourceRevision: "a".repeat(32),
      fromRevision: "c".repeat(32),
      toRevision: "b".repeat(32),
      date: "2026-10-30",
      cleared: false
    });
    await act(async () => finish({ status: "cancelled" }));
    expect(button(renderer, "Confirm correction")!.props.disabled).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => {
      void button(renderer, "Confirm correction")!.props.onClick();
    });
    await act(async () => finish({ status: "failed" }));
    expect(button(renderer, "Confirm correction")!.props.disabled).toBe(true);
    const corrected = {
      ...context(),
      receipt: {
        ...context().receipt,
        correctedBy: { transferId: "99000000-0000-4000-8000-000000000002", date: "2026-10-30" }
      }
    };
    invokeTool.mockResolvedValue({ kind: "ok", result: corrected });
    await act(async () => button(renderer, "Check saved transfer")!.props.onClick());
    expect(button(renderer, "Confirm correction")).toBeUndefined();
    expect(button(renderer, "View correction")).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });
  it("explains unavailable endpoints instead of offering a correction", async () => {
    invokeTool.mockResolvedValue({ kind: "ok", result: { ...context(), accounts: [] } });
    const invoke = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(TransferCorrectionDialog, {
          transferId: originalId,
          tools: { invoke },
          onClose: vi.fn(),
          onSaved: vi.fn(),
          onReview: vi.fn()
        })
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Both ledgers must be open");
    expect(button(renderer, "Review correction")!.props.disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});
