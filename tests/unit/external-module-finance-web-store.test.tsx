// @vitest-environment jsdom
//
// #3197: after invalidateQueries() a mounted screen must refetch and leave the loading state
// without a remount or a key change.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeTool = vi.fn();
vi.mock("../../external-modules/finance/src/web/api", () => ({
  invokeTool: (...args: unknown[]) => invokeTool(...args),
  resetWriteQueues: () => undefined
}));

import {
  __resetStoreForTests,
  invalidateQueries,
  invalidateToolQueries,
  useToolQuery
} from "../../external-modules/finance/src/web/store";

function Probe() {
  const snap = useToolQuery<{ n: number }>("finance_feed");
  if (snap.status === "loading") return createElement("div", null, "loading");
  return createElement(
    "div",
    null,
    snap.outcome.kind === "ok" ? `n=${snap.outcome.result.n}` : "other"
  );
}

afterEach(() => {
  __resetStoreForTests();
  invokeTool.mockReset();
});

describe("finance tool query store (#3197)", () => {
  it("refetches for a mounted screen after invalidateQueries", async () => {
    invokeTool
      .mockResolvedValueOnce({ kind: "ok", result: { n: 1 } })
      .mockResolvedValueOnce({ kind: "ok", result: { n: 2 } });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Probe));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("n=1");

    await act(async () => {
      invalidateQueries();
    });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(renderer.toJSON())).toContain("n=2");
  });

  it("refreshes detail reads without refetching unrelated report totals", async () => {
    function ScopedProbe(props: { name: string }) {
      const snap = useToolQuery<{ n: number }>(props.name);
      return createElement("div", null, snap.status);
    }
    invokeTool.mockResolvedValue({ kind: "ok", result: { n: 1 } });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          "div",
          null,
          createElement(ScopedProbe, { name: "finance.reports.transactions" }),
          createElement(ScopedProbe, { name: "finance.reports.spending" })
        )
      );
    });
    invokeTool.mockClear();
    await act(async () => invalidateToolQueries("finance.reports.transactions"));
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenLastCalledWith("finance.reports.transactions", undefined);
    await act(async () => renderer.unmount());
  });

  it("reads again on the next visit after a failed read, but keeps a good one", async () => {
    invokeTool
      .mockResolvedValueOnce({ kind: "error", message: "Network error" })
      .mockResolvedValueOnce({ kind: "ok", result: { n: 3 } });

    let first!: ReactTestRenderer;
    await act(async () => {
      first = create(createElement(Probe));
    });
    expect(JSON.stringify(first.toJSON())).toContain("other");
    await act(async () => first.unmount());

    let second!: ReactTestRenderer;
    await act(async () => {
      second = create(createElement(Probe));
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(second.toJSON())).toContain("n=3");
    await act(async () => second.unmount());

    let third!: ReactTestRenderer;
    await act(async () => {
      third = create(createElement(Probe));
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(third.toJSON())).toContain("n=3");
  });

  it("ignores an older answer that arrives after a newer one", async () => {
    let resolveFirst!: (value: unknown) => void;
    invokeTool
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ kind: "ok", result: { n: 2 } });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Probe));
    });
    await act(async () => {
      invalidateQueries();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("n=2");

    await act(async () => {
      resolveFirst({ kind: "ok", result: { n: 1 } });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("n=2");
  });
});
