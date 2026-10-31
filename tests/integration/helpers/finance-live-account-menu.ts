// Accounts screen actions for the Finance live tests. Manual account actions sit in each row's
// menu, and Add manual account sits in the Add account menu once any account exists.
import type { Page } from "playwright-core";

/** Opens Add manual account from the empty state's button or from the Add account menu. */
export async function openAddManualAccount(page: Page): Promise<void> {
  const direct = page.getByRole("button", { name: "Add manual account", exact: true });
  const menu = page.getByRole("button", { name: "Add account", exact: true });
  await direct.or(menu).first().waitFor();
  if (await direct.isVisible()) return direct.click();
  await menu.click();
  await page.getByRole("menuitem", { name: "Add manual account", exact: true }).click();
}

/** Runs one item from an account row's menu, named as in "Reconcile Synthetic wallet". */
export async function accountAction(page: Page, account: string, action: string): Promise<void> {
  await page.getByRole("button", { name: `Actions for ${account}`, exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
