// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { it, expect, vi } from "vitest";
import {
  EMPTY_FILTERS,
  RegisterFilterChips,
  RegisterFilterPanel,
  activeFilterCount,
  filterInput
} from "../../external-modules/finance/src/web/register-filters";
it("includes ledger status in the active count, query and clear lifecycle", async () => {
  const value = { ...EMPTY_FILTERS, ledgerState: "cleared" as const };
  const onChange = vi.fn();
  let r!: ReactTestRenderer;
  try {
    await act(async () => {
      r = create(
        createElement(RegisterFilterPanel, { value, onChange, accounts: [], categories: [] })
      );
    });
    expect(activeFilterCount(value)).toBe(1);
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

it("shows each active filter as a chip that removes only that filter", async () => {
  const value = { ...EMPTY_FILTERS, accountId: "acc-1", direction: "outflow" as const };
  const onChange = vi.fn();
  const onIncludeShared = vi.fn();
  let r!: ReactTestRenderer;
  try {
    await act(async () => {
      r = create(
        createElement(RegisterFilterChips, {
          value,
          onChange,
          accounts: [{ accountId: "acc-1", name: "Rewards Visa" }],
          categories: [],
          ownOnly: true,
          onIncludeShared
        })
      );
    });
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Rewards Visa");
    expect(text).toContain("Money out");
    expect(text).toContain("Your entries only");
    const remove = (label: string) =>
      r.root.findAllByType("button").find((b) => b.props["aria-label"] === label)!;
    await act(async () => remove("Remove account filter Rewards Visa").props.onClick());
    expect(onChange).toHaveBeenLastCalledWith({ ...value, accountId: "" });
    await act(async () => remove("Include shared records").props.onClick());
    expect(onIncludeShared).toHaveBeenCalledTimes(1);
  } finally {
    if (r) await act(async () => r.unmount());
  }
});

it("renders no chip row when nothing is filtered", async () => {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      createElement(RegisterFilterChips, {
        value: EMPTY_FILTERS,
        onChange: vi.fn(),
        accounts: [],
        categories: [],
        ownOnly: false,
        onIncludeShared: vi.fn()
      })
    );
  });
  expect(r.toJSON()).toBeNull();
  await act(async () => r.unmount());
});
