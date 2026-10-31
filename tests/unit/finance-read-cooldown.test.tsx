// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, it, expect, vi } from "vitest";
import { ManualAccountManager } from "../../external-modules/finance/src/web/account-management";
import { invokeTool } from "../../external-modules/finance/src/web/api";
let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("busy Finance read recovery", () => {
  it("honors the server wait and sends no automatic request or write", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "1" },
        json: async () => ({})
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          invocation: {
            status: "succeeded",
            result: {
              status: "ok",
              today: "2026-10-30",
              account: {
                accountId: "manual:test",
                name: "Synthetic cash",
                type: "depository",
                subtype: "checking",
                isoCurrency: "USD",
                balanceCents: 0,
                openingBalanceCents: 0,
                openingDate: "2026-10-01",
                balanceAsOf: "2026-10-30 UTC",
                archivedAt: null,
                lastReconciledDate: null,
                lastEntryDate: null,
                revision: "a".repeat(32),
                canClose: true,
                blockers: [],
                futurePlanCount: 0
              }
            }
          }
        })
      });
    vi.stubGlobal("fetch", fetch);
    const invoke = vi.fn();
    await act(async () => {
      rendered = create(
        createElement(ManualAccountManager, {
          accountId: "manual:test",
          tools: { invoke },
          onClose: vi.fn(),
          onSaved: vi.fn(),
          onReconcile: vi.fn()
        })
      );
    });
    const retry = () =>
      rendered!.root
        .findAllByType("button")
        .find((b) => b.children.includes("Review saved account"))!;
    expect(JSON.stringify(rendered!.toJSON())).toContain("Wait 1 second");
    expect(retry().props.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(retry().props.disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      retry().props.onClick();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(rendered!.toJSON())).toContain("Rename account");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("uses a bounded default for an invalid retry header, without leaking response content", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "Infinity" },
      json: async () => {
        throw new Error("The body should not be needed");
      }
    }));
    vi.stubGlobal("fetch", fetch);
    expect(await invokeTool("finance.manual.account-review", { accountId: "manual:test" })).toEqual(
      {
        kind: "error",
        message:
          "Finance is temporarily busy. Wait 60 seconds, then try again. Your inputs are kept.",
        retryAfterSeconds: 60
      }
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
