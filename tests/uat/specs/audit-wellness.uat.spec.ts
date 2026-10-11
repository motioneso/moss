import { expect, test, type Page } from "@playwright/test";
import { EMOTIONS, localDay, type CheckinDto, type MedicationScheduleResponse } from "@moss/shared";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Task #3397. Real isolated UI/API/worker proof using fictional records only.
// No route interception or response replacement. Network interruption uses actual browser offline mode.
export const uatLevel = { level: "admin+data", without: [] } as const;

function baseURL() {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}
async function signIn(page: Page) {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const account = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(account).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(account).toBeVisible();
}

test("Wellness keeps full chart inputs, older corrections, dose recovery and export identity", async ({
  page,
  context
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  const locale = await page.request.put(`${baseURL()}/api/me/locale`, {
    data: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  expect(locale.ok()).toBe(true);
  const seeded: CheckinDto[] = [];
  for (let index = 0; index < 101; index++) {
    const feelingCore = index < 50 ? "happy" : "sad";
    const response = await page.request.post(`${baseURL()}/api/wellness/checkins`, {
      data: {
        feelingCore,
        feelingSecondary: EMOTIONS.find((emotion) => emotion.core === feelingCore)!.feelings[0]!
          .label,
        intensity: index < 50 ? 1 : 5,
        note: `Fictional audit reflection ${index}`,
        identifiedVia: "wheel"
      }
    });
    expect(response.status()).toBe(201);
    seeded.push(((await response.json()) as { checkin: CheckinDto }).checkin);
  }
  await page.goto(`${baseURL()}/wellness`);
  await expect(page.getByText("Mood · 14 completed days", { exact: true })).toBeVisible();
  await expect(page.getByText("Streak · through yesterday", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved today", { exact: true })).toBeVisible();
  await page.getByText("View daily values", { exact: true }).click();
  const today = localDay(new Date(), "UTC");
  const dayRow = page
    .getByRole("table", { name: "Mood and medication observations" })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: today, exact: true }) });
  await expect(dayRow.getByRole("cell").first()).toHaveText("-2");
  const oldest = seeded[0]!;
  while (!(await page.locator(`[aria-controls="checkin-${oldest.id}"]`).count())) {
    await page.getByRole("button", { name: /^(Show .* more|Load older check-ins)$/ }).click();
  }
  await page.locator(`[aria-controls="checkin-${oldest.id}"]`).click();
  await page
    .locator(`[id="checkin-${oldest.id}"]`)
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const checkinDialog = page.getByRole("dialog", {
    name: "How are you feeling right now?",
    exact: true
  });
  await checkinDialog
    .getByLabel("Check-in note (optional)")
    .fill("Fictional audit correction beyond fifty");
  await checkinDialog.getByRole("button", { name: "Update check-in", exact: true }).click();
  await expect(checkinDialog).toHaveCount(0);
  const readback = await page.request.get(`${baseURL()}/api/wellness/checkins?limit=500`);
  expect(
    ((await readback.json()) as { checkins: CheckinDto[] }).checkins.find(
      (entry) => entry.id === oldest.id
    )?.note
  ).toBe("Fictional audit correction beyond fifty");

  const medication = await page.request.post(`${baseURL()}/api/wellness/medications`, {
    data: {
      name: "Fictional scheduled dose",
      frequencyType: "once_daily",
      scheduleTimes: ["08:00"],
      startDate: today,
      remindersEnabled: false
    }
  });
  expect(medication.status()).toBe(201);
  await page.reload();
  const dose = page.getByRole("button", { name: /^Fictional scheduled dose,/ });
  await expect(dose).toContainText("Pending");
  await context.setOffline(true);
  try {
    await dose.click();
    await expect(page.getByRole("alert")).toContainText("Could not save");
  } finally {
    await context.setOffline(false);
  }
  await page.getByRole("button", { name: "Retry dose", exact: true }).click();
  await expect(dose).toContainText("Taken");
  const scheduleRead = await page.request.get(
    `${baseURL()}/api/wellness/medications/schedule?date=${today}`
  );
  expect(
    ((await scheduleRead.json()) as MedicationScheduleResponse).slots.find(
      (slot) => slot.name === "Fictional scheduled dose"
    )?.status
  ).toBe("taken");
  await dose.click();
  await expect(dose).toContainText("Skipped");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  let exportDialog = page.getByRole("dialog", { name: "Export for a clinician", exact: true });
  await expect(exportDialog).toContainText("UTC");
  await exportDialog.getByLabel("From", { exact: true }).fill(today);
  await exportDialog.getByLabel("To", { exact: true }).fill(today);
  for (const name of ["Medications & logs", "Therapy notes", "Insights"])
    await exportDialog.getByLabel(name, { exact: true }).uncheck();
  await exportDialog.getByRole("checkbox").last().check();
  await exportDialog.getByRole("button", { name: "Generate export", exact: true }).click();
  await expect(exportDialog.getByText(/Building your export|Your export is ready/)).toBeVisible();
  await exportDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`${baseURL()}/tasks`);
  await page.goto(`${baseURL()}/wellness`);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  exportDialog = page.getByRole("dialog", { name: "Export for a clinician", exact: true });
  const download = exportDialog.getByRole("link", { name: "Download", exact: true });
  await expect(download).toBeVisible({ timeout: 60_000 });
  const href = await download.getAttribute("href");
  expect(href).toMatch(/^\/api\/me\/export\/download\//);
  const artifact = await page.request.get(`${baseURL()}${href}`);
  expect(artifact.status()).toBe(200);
  expect(await artifact.text()).toContain("Fictional audit correction beyond fifty");
});
