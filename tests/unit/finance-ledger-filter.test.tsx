// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { it, expect, vi } from "vitest";
import {
  EMPTY_FILTERS,
  RegisterFilterBar,
  filterInput
} from "../../external-modules/finance/src/web/register-filters";
it("includes ledger status in the mobile active count, query and clear lifecycle", async () => {
  const value = { ...EMPTY_FILTERS, ledgerState: "cleared" as const };
  const onChange = vi.fn();
  let r!: ReactTestRenderer;
  try {
    await act(async () => {
      r = create(
        createElement(RegisterFilterBar, { value, onChange, accounts: [], categories: [] })
      );
    });
    expect(JSON.stringify(r.toJSON())).toContain("1 active");
    expect(filterInput(value)).toEqual({ ledgerState: "cleared" });
    const select = r.root
      .findAllByType("select")
      .find((s) => s.props["aria-label"] === "Filter by manual ledger status")!;
    await act(async () => select.props.onChange({ target: { value: "reconciled" } }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, ledgerState: "reconciled" });
    const clear = r.root.findAllByType("button").find((b) => b.children.includes("Clear filters"))!;
    await act(async () => clear.props.onClick());
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
    expect(filterInput(EMPTY_FILTERS)).toEqual({});
  } finally {
    if (r) await act(async () => r.unmount());
  }
});
