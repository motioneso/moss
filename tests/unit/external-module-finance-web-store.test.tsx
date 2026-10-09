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
  invokeTool: (...args: unknown[]) => invokeTool(...args)
}));

import {
  __resetStoreForTests,
  invalidateQueries,
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
});
