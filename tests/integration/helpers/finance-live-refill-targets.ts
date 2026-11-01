import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function exerciseRefillTarget(
  page: Page,
  month: string,
  read: Read,
  ready: (page: Page, action: Locator) => Promise<void>,
  openFunding: (page: Page) => Promise<void>,
  inspect: (dialog: Locator, label: string) => Promise<void>
) {
  const status = () => read("finance.budget.status", { month });
  const categories = (view: Record<string, unknown>) =>
    (view.state as { categories: unknown }).categories;
  const before = await status();
  const add = page.getByRole("button", { name: "Add a target", exact: true });
  await ready(page, add);
  await add.click();
  const editor = page.getByRole("dialog", { name: "Add a target", exact: true });
  await editor.getByLabel("Target category", { exact: true }).selectOption("utilities");
  await editor.getByLabel("Target type", { exact: true }).selectOption("refill");
  await editor.getByLabel("Target amount", { exact: true }).fill("12.01");
  await inspect(editor, "refill-editor");
  await editor.getByRole("button", { name: "Save target", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  expect(categories(await status())).toEqual(categories(before));
  expect((await status()).readyToAssignCents).toBe(before.readyToAssignCents);
  await page.reload();
  const edit = page
    .getByRole("region", { name: "Category targets", exact: true })
    .locator(".jds-index__row")
    .filter({ hasText: "Utilities" })
    .getByRole("button", { name: "Edit target", exact: true });
  await ready(page, edit);
  await edit.click();
  const savedEditor = page.getByRole("dialog", { name: "Edit target", exact: true });
  expect(await savedEditor.getByLabel("Target type", { exact: true }).inputValue()).toBe("refill");
  expect(await savedEditor.getByLabel("Target amount", { exact: true }).inputValue()).toBe("12.01");
  await savedEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  await openFunding(page);
  const selection = page.getByRole("dialog", { name: "Choose target funding", exact: true });
  // The one eligible plan precedes already reached contribution targets on compact screens.
  expect(await selection.getByRole("checkbox").first().getAttribute("aria-label")).toBe(
    "Fund Utilities"
  );
  await selection.getByRole("checkbox", { name: "Fund Utilities", exact: true }).check();
  await selection.getByText(/Monthly refill · includes carried money/).waitFor();
  await inspect(selection, "refill-selection");
  await selection.getByRole("button", { name: "Review selected amounts", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review target assignments", exact: true });
  await review.getByText("$0.00 → $12.01", { exact: true }).waitFor();
  await inspect(review, "refill-review");
  const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await review
    .getByText("Cancelled. Your captured funding selection is kept.", { exact: true })
    .waitFor();
  expect(categories(await status())).toEqual(categories(before));
  await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await review.waitFor({ state: "detached" });
  const after = await status();
  expect(after.state).toMatchObject({ categories: { utilities: { assignedCents: 1201 } } });
  expect(after.readyToAssignCents).toBe((before.readyToAssignCents as number) - 1201);
}
