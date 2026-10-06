import { expect, type Page } from "@playwright/test";

export function meetingRow(page: Page, title: string) {
  return page.locator(".meetings-history-row").filter({
    has: page.getByText(title, { exact: true })
  });
}

export async function openMeetingAction(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Meeting actions", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

export async function openMeetingChat(page: Page): Promise<void> {
  const toggle = page.locator(".topbar-actions").getByRole("button", {
    name: /^(Chat with .+|Open chat)$/
  });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(
    page.getByRole("button", { name: "Remove meeting context", exact: true })
  ).toBeVisible();
}

export async function assertMinimalMeetingWorkspace(page: Page): Promise<void> {
  const workspace = page.getByRole("region", { name: "Meeting workspace", exact: true });
  await expect(workspace).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(workspace.getByRole("radio")).toHaveCount(0);
  await expect(workspace.getByRole("checkbox")).toHaveCount(0);
  for (const name of [
    "Recording device",
    "Recording Mac",
    "Microphone",
    "Meeting app",
    "Summary style"
  ])
    await expect(workspace.getByLabel(name, { exact: true })).toHaveCount(0);
  for (const name of [
    "Generate summary",
    "Write summary",
    "Save notes",
    "Create draft",
    "Ask Moss"
  ])
    await expect(workspace.getByRole("button", { name, exact: true })).toHaveCount(0);
  await workspace.getByRole("button", { name: "Meeting actions", exact: true }).click();
  const menu = workspace.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveCount(6);
  for (const name of [
    "Search transcript",
    "Rewrite summary",
    "Earlier versions",
    "Save to vault",
    "Copy as Markdown",
    "Delete meeting"
  ])
    await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(workspace).not.toContainText(
    /\b(draft|Source labels only|Output scope|Capture: Unavailable)\b/
  );
}
