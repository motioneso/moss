import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function exerciseWeeklyTarget(
  page: Page,
  month: string,
  read: Read,
  ready: (page: Page, action: Locator) => Promise<void>,
  openFunding: (page: Page) => Promise<void>,
  inspect: (dialog: Locator, label: string) => Promise<void>
) {
  // Independent browser oracle: enumerate valid UTC dates instead of importing target math.
  let fridays = 0;
  for (let day = 1; day <= 31; day++) {
    const date = new Date(`${month}-${String(day).padStart(2, "0")}T12:00:00Z`);
    if (date.toISOString().startsWith(month) && date.getUTCDay() === 5) fridays++;
  }
  const total = fridays * 101;
  const status = () => read("finance.budget.status", { month });
  const ledgerState = (view: Record<string, unknown>) => {
    const state = view.state as { categories: unknown; tbbCents: number };
    return { categories: state.categories, tbbCents: state.tbbCents };
  };
  const before = await status();
  const add = page.getByRole("button", { name: "Add a target", exact: true });
  await ready(page, add);
  await add.click();
  const editor = page.getByRole("dialog", { name: "Add a target", exact: true });
  await editor.getByLabel("Target category", { exact: true }).selectOption("transport");
  await editor.getByLabel("Target type", { exact: true }).selectOption("weekly");
  await editor.getByLabel("Target amount", { exact: true }).fill("1.01");
  expect(await editor.getByRole("button", { name: "Save target", exact: true }).isDisabled()).toBe(
    true
  );
  await editor.getByLabel("Contribution weekday", { exact: true }).selectOption("5");
  await editor
    .getByRole("status")
    .filter({ hasText: `${fridays} Fridays` })
    .waitFor();
  await inspect(editor, "weekly-editor");
  await editor.getByRole("button", { name: "Save target", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  expect(ledgerState(await status())).toEqual(ledgerState(before));
  expect((await status()).readyToAssignCents).toBe(before.readyToAssignCents);
  await page.reload();
  const edit = page
    .getByRole("region", { name: "Category targets", exact: true })
    .locator(".jds-index__row")
    .filter({ hasText: "Transport" })
    .getByRole("button", { name: "Edit target", exact: true });
  await ready(page, edit);
  await edit.click();
  const savedEditor = page.getByRole("dialog", { name: "Edit target", exact: true });
  expect(await savedEditor.getByLabel("Contribution weekday", { exact: true }).inputValue()).toBe(
    "5"
  );
  expect(await savedEditor.getByLabel("Target amount", { exact: true }).inputValue()).toBe("1.01");
  await savedEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  await openFunding(page);
  const selection = page.getByRole("dialog", { name: "Choose target funding", exact: true });
  await selection.getByRole("checkbox", { name: "Fund Transport", exact: true }).check();
  await selection.getByText(new RegExp(`${fridays} Fridays`)).waitFor();
  await inspect(selection, "weekly-selection");
  await selection.getByRole("button", { name: "Review selected amounts", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review target assignments", exact: true });
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    total / 100
  );
  await review.getByText(`$0.00 → ${money}`, { exact: true }).waitFor();
  await inspect(review, "weekly-review");
  const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await review
    .getByText("Cancelled. Your captured funding selection is kept.", { exact: true })
    .waitFor();
  expect(ledgerState(await status())).toEqual(ledgerState(before));
  await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await review.waitFor({ state: "detached" });
  const after = await status();
  expect(after.state).toMatchObject({ categories: { transport: { assignedCents: total } } });
  expect(after.readyToAssignCents).toBe((before.readyToAssignCents as number) - total);
}
