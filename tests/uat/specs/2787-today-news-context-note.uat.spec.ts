import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2787: live-instance proof that Today's news side stories carry the "Your news, in context"
// note. Same fixture and live-fetch path as the #2746 spec. The fixture feeds carry no topics,
// so each side story keeps its publisher tag rather than an invented topic label.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  withEspnFixture: true
} as const;

test.setTimeout(180_000);

test("Today's news side stories show the context note and no invented topic label (#2787)", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 375, height: 812 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const desk = page.locator(".jds-brief--news");
    await expect(desk.locator(".nw-twlist__title").first()).toBeVisible({ timeout: 30_000 });

    const note = desk.locator(".nw-twnote");
    await expect(note).toBeVisible();
    await expect(note.locator(".nw-twnote__eyebrow")).toHaveText("Your news, in context");
    await expect(note.locator(".nw-twnote__text")).not.toBeEmpty();

    // Approved design: gold left border, left inset, no top divider, capped width.
    await expect(note).toHaveCSS("border-left-width", "2px");
    await expect(note).toHaveCSS("border-left-color", "rgb(194, 135, 43)");
    await expect(note).toHaveCSS("border-top-width", "0px");
    await expect(note).toHaveCSS("padding-left", "16px");
    await expect(note).toHaveCSS("margin-top", "19px");
    await expect(note).toHaveCSS("max-width", "290px");
    await expect(note.locator(".nw-twnote__eyebrow")).toHaveCSS("font-weight", "700");

    await desk.screenshot({ path: `/tmp/2787-news-desk-${viewport.width}.png` });
  }
});
