// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import {
  ReportDetails,
  type ReportSelection
} from "../../external-modules/finance/src/web/report-details";
const { read, refresh } = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn() }));
vi.mock("../../external-modules/finance/src/web/store", () => ({
  useToolQuery: read,
  invalidateToolQueries: refresh
}));
const selection: ReportSelection = {
  month: "2026-10",
  months: 6,
  currency: "USD",
  group: "category",
  key: "groceries",
  sharedOwnerIds: [],
  expectedCents: 100,
  label: "Groceries"
};
const row = {
  id: "synthetic",
  ownerUserId: "owner",
  shared: false,
  accountId: "synthetic",
  accountName: "Synthetic cash",
  date: "2026-10-15",
  name: "Synthetic market",
  amountCents: 100,
  parentAmountCents: 150,
  isoCurrency: "USD",
  pending: true,
  splitPortion: true,
  splitNeedsReview: false
};
const settled = (result: Record<string, unknown>) => ({
  status: "settled",
  outcome: { kind: "ok", result }
});
const button = (r: ReactTestRenderer, label: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(label))!;
describe("report detail review scope and pagination", () => {
  it("keeps busy-read selection and waits for Retry-After before an explicit reload", async () => {
    vi.useFakeTimers();
    refresh.mockClear();
    read.mockReturnValue({
      status: "settled",
      outcome: {
        kind: "error",
        message: "Finance is temporarily busy. Wait 8 seconds, then try again.",
        retryAfterSeconds: 8
      }
    });
    let r!: ReactTestRenderer;
    try {
      await act(async () => {
        r = create(createElement(ReportDetails, { selection, onClose: vi.fn() }));
      });
      expect(JSON.stringify(r.toJSON())).toContain("Wait 8 seconds");
      expect(button(r, "Reload details").props.disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(8000);
      });
      expect(refresh).not.toHaveBeenCalled();
      expect(button(r, "Reload details").props.disabled).toBe(false);
      await act(async () => button(r, "Reload details").props.onClick());
      expect(refresh).toHaveBeenCalledExactlyOnceWith("finance.reports.transactions");
    } finally {
      if (r) await act(async () => r.unmount());
      vi.useRealTimers();
    }
  });
  it("keeps its captured scope when the report changes and explains a new total", async () => {
    read.mockReturnValue(
      settled({
        rows: [{ ...row, amountCents: 110 }],
        totalCount: 1,
        totalCents: 110,
        offset: 0,
        limit: 50
      })
    );
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(createElement(ReportDetails, { selection, onClose: vi.fn() }));
    });
    await act(async () =>
      r.update(
        createElement(ReportDetails, {
          selection: { ...selection, month: "2026-11", currency: "EUR", expectedCents: 999 },
          onClose: vi.fn()
        })
      )
    );
    expect(read).toHaveBeenLastCalledWith(
      "finance.reports.transactions",
      expect.objectContaining({
        month: "2026-10",
        currency: "USD",
        key: "groceries",
        offset: 0,
        limit: 50
      })
    );
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("The records changed since");
    expect(text).toContain("Whole transaction:");
    expect(text).toContain("$1.50");
    expect(text).toContain("Pending");
    await act(async () => r.unmount());
  });
  it("paginates loaded records without presenting the page sum as the full total", async () => {
    read.mockImplementation((_tool: string, input: { offset: number }) =>
      settled({
        rows: Array.from({ length: input.offset ? 1 : 50 }, (_, i) => ({
          ...row,
          id: `synthetic:${i}`
        })),
        totalCount: 51,
        totalCents: 9999,
        offset: input.offset,
        limit: 50
      })
    );
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(createElement(ReportDetails, { selection, onClose: vi.fn() }));
    });
    expect(button(r, "Previous page").props.disabled).toBe(true);
    expect(button(r, "Next page").props.disabled).toBe(false);
    expect(JSON.stringify(r.toJSON())).toContain("$99.99");
    await act(async () => button(r, "Next page").props.onClick());
    expect(read).toHaveBeenLastCalledWith(
      "finance.reports.transactions",
      expect.objectContaining({ offset: 50 })
    );
    expect(button(r, "Next page").props.disabled).toBe(true);
    expect(button(r, "Previous page").props.disabled).toBe(false);
    expect(JSON.stringify(r.toJSON())).toContain("51–51 of 51 transactions");
    expect(JSON.stringify(r.toJSON())).toContain("$99.99");
    await act(async () => r.unmount());
  });
  it("retains the dialog after a network error and offers an explicit reload", async () => {
    read.mockReturnValue({
      status: "settled",
      outcome: { kind: "error", message: "Network error" }
    });
    refresh.mockClear();
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(createElement(ReportDetails, { selection, onClose: vi.fn() }));
    });
    expect(JSON.stringify(r.toJSON())).toContain("Report transactions could not load.");
    await act(async () => button(r, "Reload details").props.onClick());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("finance.reports.transactions");
    await act(async () => r.unmount());
  });
});
