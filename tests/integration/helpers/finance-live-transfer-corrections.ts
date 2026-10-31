import { parseCsv } from "../../../external-modules/finance/src/domain/csv-import.js";
import { dayYearLabel } from "../../../external-modules/finance/src/web/format.js";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import type { TransferReview } from "../../../external-modules/finance/src/domain/transfer-corrections.js";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Row = { id: string; accountId: string; transferId?: string; amountCents: number };
export async function exerciseTransferCorrection(
  page: Page,
  read: Read,
  today: string,
  artifacts?: string
) {
  const month = today.slice(0, 7),
    rows = async () =>
      (await read("finance.transactions.query", { month, ownOnly: true, limit: 2000 }))
        .transactions as Row[];
  const before = await rows(),
    originalId = before.find(
      (r) => r.accountId === "manual:transfer-cash" && r.amountCents === 345
    )!.transferId!;
  expect(originalId).toBeTruthy();
  const originalRows = before.filter((r) => r.transferId === originalId);
  expect(originalRows).toHaveLength(2);
  const report = await read("finance.reports.spending", { months: 1, currency: "USD" });
  await page
    .locator(`button[data-finance-transfer-id="${originalId}"]`)
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Review manual transfer", exact: true });
  const ready = dialog
      .getByRole("button", { name: "Review correction", exact: true })
      .and(page.locator(":enabled")),
    busy = dialog.getByRole("status").filter({ hasText: /Finance is temporarily busy/ });
  await ready.or(busy).first().waitFor();
  if (await busy.isVisible()) {
    const seconds = Number((await busy.innerText()).match(/Wait (\d+) seconds?/)?.[1]);
    expect(Number.isFinite(seconds) && seconds >= 1 && seconds <= 60).toBe(true);
    await page.waitForTimeout(seconds * 1000 + 100);
    await dialog.getByRole("button", { name: "Check saved transfer", exact: true }).click();
  }
  await ready.waitFor();
  await dialog.getByLabel("Correction date", { exact: true }).fill(today);
  await ready.click();
  await dialog.getByText("$46.55 → $50.00 owed.", { exact: false }).waitFor();
  await dialog.getByText("$84.20 → $87.65.", { exact: false }).waitFor();
  for (const theme of ["light", "dark", "sage"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      expect(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
      const foot = (await dialog.locator(".jds-dialog__foot").boundingBox())!;
      expect(foot.y + foot.height).toBeLessThanOrEqual(900);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-transfer-correction-${theme}-${width}.png`)
        });
    }
  }
  const confirm = () =>
      dialog.getByRole("button", { name: "Confirm correction", exact: true }).click(),
    guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  await confirm();
  try {
    await guard.waitFor();
  } catch (error) {
    if (process.env.MOSS_FINANCE_REVERSE_CONFIRM_NEGATIVE === "1") {
      const actual = await read("finance.manual.transfer-review", {
        originalTransferId: originalId
      });
      expect(
        (actual.receipt as TransferReview).correctedBy,
        "A correction must await the host confirmation"
      ).toBeNull();
    }
    throw error;
  }
  expect(await rows()).toEqual(before);
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog
    .getByText("Cancelled. Your captured correction is kept; no new entries were recorded.", {
      exact: true
    })
    .waitFor();
  expect(await rows()).toEqual(before);
  await confirm();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const review = (await read("finance.manual.transfer-review", { originalTransferId: originalId }))
    .receipt as TransferReview;
  expect(review.correctedBy).toMatchObject({ date: today });
  const correctionId = review.correctedBy!.transferId,
    saved = await rows();
  expect(saved.filter((r) => r.transferId === originalId)).toEqual(originalRows);
  expect(
    saved
      .filter((r) => r.transferId === correctionId)
      .map((r) => r.amountCents)
      .sort()
  ).toEqual([-345, 345]);
  const accounts = (await read("finance.manual.transfer-context")).accounts as {
    accountId: string;
    balanceCents: number;
  }[];
  expect(accounts.find((a) => a.accountId === "manual:transfer-cash")!.balanceCents).toBe(8765);
  expect(accounts.find((a) => a.accountId === "manual:transfer-card")!.balanceCents).toBe(5000);
  expect((await read("finance.reports.spending", { months: 1, currency: "USD" })).own).toEqual(
    report.own
  );
  const exported = await read("finance.transactions.export", {
    from: `${month}-01`,
    through: today,
    accountId: "manual:transfer-cash"
  });
  expect(exported.csv).toContain("Corrects transfer ID,Corrected by transfer ID");
  const links = parseCsv(String(exported.csv)).rows.map((row) => row.slice(-3));
  expect(links).toContainEqual([originalId, "", correctionId]);
  expect(links).toContainEqual([correctionId, originalId, ""]);
  await page.reload();
  await page
    .locator(`button[data-finance-transfer-id="${originalId}"]`)
    .filter({ visible: true })
    .first()
    .click();
  const recordedOn = dayYearLabel(today, "short");
  await dialog
    .getByText(`Correction recorded on ${recordedOn}. The original cannot be corrected twice.`, {
      exact: true
    })
    .waitFor();
  expect(await dialog.getByRole("button", { name: "Review correction", exact: true }).count()).toBe(
    0
  );
  await dialog.getByRole("button", { name: "View correction", exact: true }).click();
  await dialog.getByRole("button", { name: "View original recording", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}
