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

// Chip remove buttons unmount with their chip, so focus has to move before the filter clears.
type ChipProps = Parameters<typeof RegisterFilterChips>[0];
const chipButtons = (count: number) => Array.from({ length: count }, () => ({ focus: vi.fn() }));

async function renderChips(over: Partial<ChipProps>, buttons: { focus: () => void }[]) {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      createElement(RegisterFilterChips, {
        value: {
          ...EMPTY_FILTERS,
          accountId: "acc-1",
          postingState: "posted" as const,
          direction: "outflow" as const
        },
        onChange: vi.fn(),
        accounts: [{ accountId: "acc-1", name: "Rewards Visa" }],
        categories: [],
        ownOnly: false,
        onIncludeShared: vi.fn(),
        ...over
      }),
      {
        createNodeMock: (element) =>
          (element.props as { className?: string }).className === "fnm-chips"
            ? { querySelectorAll: () => buttons }
            : null
      }
    );
  });
  return r;
}

const press = (r: ReactTestRenderer, name: string) =>
  act(async () =>
    r.root
      .findAllByType("button")
      .find((b) => b.props["aria-label"] === name || b.children.includes(name))!
      .props.onClick()
  );

it("moves focus to the next chip when a chip is removed", async () => {
  const buttons = chipButtons(3);
  const returnFocus = vi.fn();
  const r = await renderChips({ returnFocus }, buttons);
  await press(r, "Remove account filter Rewards Visa");
  expect(buttons[1]!.focus).toHaveBeenCalledOnce();
  expect(buttons[0]!.focus).not.toHaveBeenCalled();
  expect(buttons[2]!.focus).not.toHaveBeenCalled();
  expect(returnFocus).not.toHaveBeenCalled();
  await act(async () => r.unmount());
});

it("moves focus to the previous chip when the last chip is removed", async () => {
  const buttons = chipButtons(3);
  const r = await renderChips({ returnFocus: vi.fn() }, buttons);
  await press(r, "Remove money direction filter Money out");
  expect(buttons[1]!.focus).toHaveBeenCalledOnce();
  expect(buttons[0]!.focus).not.toHaveBeenCalled();
  expect(buttons[2]!.focus).not.toHaveBeenCalled();
  await act(async () => r.unmount());
});

it("counts the Your entries only chip when it picks the neighbouring chip", async () => {
  const buttons = chipButtons(3);
  const onIncludeShared = vi.fn();
  const r = await renderChips(
    {
      value: { ...EMPTY_FILTERS, accountId: "acc-1", direction: "outflow" as const },
      ownOnly: true,
      onIncludeShared,
      returnFocus: vi.fn()
    },
    buttons
  );
  await press(r, "Remove account filter Rewards Visa");
  expect(buttons[2]!.focus).toHaveBeenCalledOnce();
  expect(buttons[1]!.focus).not.toHaveBeenCalled();
  await press(r, "Include shared records");
  expect(buttons[1]!.focus).toHaveBeenCalledOnce();
  expect(onIncludeShared).toHaveBeenCalledOnce();
  await act(async () => r.unmount());
});

it("hands focus to the Filters button, before the filter clears, when the last chip goes", async () => {
  const buttons = chipButtons(1);
  const onChange = vi.fn();
  const returnFocus = vi.fn();
  const r = await renderChips(
    { value: { ...EMPTY_FILTERS, accountId: "acc-1" }, onChange, returnFocus },
    buttons
  );
  await press(r, "Remove account filter Rewards Visa");
  expect(returnFocus).toHaveBeenCalledOnce();
  expect(buttons[0]!.focus).not.toHaveBeenCalled();
  expect(returnFocus.mock.invocationCallOrder[0]).toBeLessThan(
    onChange.mock.invocationCallOrder[0]!
  );
  await act(async () => r.unmount());
});

it("hands focus to the Filters button before Clear filters empties the chips", async () => {
  const onChange = vi.fn();
  const returnFocus = vi.fn();
  const r = await renderChips({ onChange, returnFocus }, chipButtons(3));
  await press(r, "Clear filters");
  expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
  expect(returnFocus).toHaveBeenCalledOnce();
  expect(returnFocus.mock.invocationCallOrder[0]).toBeLessThan(
    onChange.mock.invocationCallOrder[0]!
  );
  await act(async () => r.unmount());
});

it("hands focus to the Filters button before the panel's Clear filters removes itself", async () => {
  const onChange = vi.fn();
  const returnFocus = vi.fn();
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      createElement(RegisterFilterPanel, {
        value: { ...EMPTY_FILTERS, direction: "inflow" as const },
        onChange,
        accounts: [],
        categories: [],
        returnFocus
      })
    );
  });
  await press(r, "Clear filters");
  expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
  expect(returnFocus).toHaveBeenCalledOnce();
  expect(returnFocus.mock.invocationCallOrder[0]).toBeLessThan(
    onChange.mock.invocationCallOrder[0]!
  );
  await act(async () => r.unmount());
});
