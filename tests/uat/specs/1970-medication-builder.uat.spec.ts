import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1970: the add-a-medication form now offers all six schedule choices, which become the eight
// frequency values the database stores. This spec creates one medication of each choice through
// the real form on a live instance, then reads them all back from the real list endpoint and
// checks each saved row carries the schedule that was picked. Nothing here is mocked: the browser
// drives the real modal, the real POST, and the real GET.
export const uatLevel = { level: "admin+data", without: [] } as const;

const START_DATE = "2026-09-01";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors the sign-in in 1974-chat-archive-settings.uat.spec.ts: admin+data stops before the
// onboarding chunk, so the seeded owner still has first-run onboarding pending.
async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function openManageMedications(page: Page) {
  await page.goto(`${requireBaseURL()}/wellness`);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.locator(".wl-modal")).toBeVisible();
}

/** Fill the shared fields, pick a schedule choice, then let the caller fill that choice's own. */
async function startMedication(page: Page, name: string, choice: string) {
  const modal = page.locator(".wl-modal");
  await modal.getByLabel("Medication name").fill(name);
  // Exact, or this also matches "Dose time 1", "Dose time 2", ...
  await modal.getByLabel("Dose", { exact: true }).fill("10 mg");
  await modal.getByRole("button", { name: choice, exact: true }).click();
  await modal.getByLabel("Start date").fill(START_DATE);
}

/** Press add and wait for the medication to show up in the list above the form. */
async function addAndConfirm(page: Page, name: string) {
  const modal = page.locator(".wl-modal");
  const addButton = modal.getByRole("button", { name: "Add medication" });
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(modal.locator(".wl-medrow__name", { hasText: name })).toBeVisible();
}

interface SavedMedication {
  readonly name: string;
  readonly frequencyType: string;
  readonly weekdays: number[] | null;
  readonly scheduleTimes: string[] | null;
  readonly timesPerDay: number | null;
  readonly intervalUnit: string | null;
  readonly intervalCount: number | null;
  readonly monthKind: string | null;
  readonly monthDay: number | null;
  readonly cycleDaysOn: number | null;
  readonly cycleDaysOff: number | null;
  readonly cycleAnchorDate: string | null;
  readonly scheduleStartDate: string | null;
  readonly remindersEnabled: boolean;
}

async function readSavedMedications(page: Page): Promise<Map<string, SavedMedication>> {
  const response = await page.request.get(`${requireBaseURL()}/api/wellness/medications`);
  expect(response.ok(), `list medications -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { medications: SavedMedication[] };
  return new Map(body.medications.map((medication) => [medication.name, medication]));
}

test("every schedule choice can be created through the real form (#1970)", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await openManageMedications(page);
  const modal = page.locator(".wl-modal");

  // 1. Every day, one time — stored as once_daily.
  await startMedication(page, "UAT Daily", "Every day");
  await modal.getByLabel("Dose time 1").fill("08:00");
  await addAndConfirm(page, "UAT Daily");

  // 2. Every day, three times — the same choice, stored as times_per_day.
  await startMedication(page, "UAT Three A Day", "Every day");
  await modal.getByLabel("Dose time 1").fill("08:00");
  await modal.getByRole("button", { name: "Add another time" }).click();
  await modal.getByLabel("Dose time 2").fill("14:00");
  await modal.getByRole("button", { name: "Add another time" }).click();
  await modal.getByLabel("Dose time 3").fill("20:00");
  await addAndConfirm(page, "UAT Three A Day");

  // 3. Certain days of the week.
  await startMedication(page, "UAT Weekdays", "Certain days");
  await modal.getByRole("button", { name: "Tuesday" }).click();
  await modal.getByRole("button", { name: "Thursday" }).click();
  await modal.getByLabel("Dose time 1").fill("07:30");
  await addAndConfirm(page, "UAT Weekdays");

  // 4. Every so often — every three days.
  await startMedication(page, "UAT Interval", "Every so often");
  await modal.getByLabel("How many days, weeks or months between doses").fill("3");
  await modal.getByRole("button", { name: "days", exact: true }).click();
  await modal.getByLabel("Dose time 1").fill("09:00");
  await addAndConfirm(page, "UAT Interval");

  // 5. Monthly, on the 15th.
  await startMedication(page, "UAT Monthly", "Monthly");
  await modal.getByRole("button", { name: "On a date" }).click();
  await modal.getByLabel("Day of the month").fill("15");
  await modal.getByLabel("Dose time 1").fill("10:00");
  await addAndConfirm(page, "UAT Monthly");

  // 6. A cycle — 21 days on, 7 off.
  await startMedication(page, "UAT Cycle", "In a cycle");
  await modal.getByLabel("Days on").fill("21");
  await modal.getByLabel("Days off").fill("7");
  await modal.getByLabel("Dose time 1").fill("11:00");
  await addAndConfirm(page, "UAT Cycle");

  // 7. Only when needed — no times, and deliberately no reminder switch.
  await startMedication(page, "UAT As Needed", "Only when needed");
  await expect(modal.getByLabel("Remind me when a dose is due")).toHaveCount(0);
  await addAndConfirm(page, "UAT As Needed");

  // Read every one of them back from the real endpoint and check the schedule survived the trip.
  const saved = await readSavedMedications(page);

  const daily = saved.get("UAT Daily");
  expect(daily?.frequencyType).toBe("once_daily");
  expect(daily?.scheduleTimes).toEqual(["08:00"]);
  expect(daily?.scheduleStartDate).toBe(START_DATE);
  expect(daily?.remindersEnabled).toBe(false);

  const threeADay = saved.get("UAT Three A Day");
  expect(threeADay?.frequencyType).toBe("times_per_day");
  expect(threeADay?.timesPerDay).toBe(3);
  expect(threeADay?.scheduleTimes).toEqual(["08:00", "14:00", "20:00"]);

  const weekdays = saved.get("UAT Weekdays");
  expect(weekdays?.frequencyType).toBe("specific_weekdays");
  expect(weekdays?.weekdays).toEqual([2, 4]);
  expect(weekdays?.scheduleTimes).toEqual(["07:30"]);

  const interval = saved.get("UAT Interval");
  expect(interval?.frequencyType).toBe("every_interval");
  expect(interval?.intervalUnit).toBe("days");
  expect(interval?.intervalCount).toBe(3);
  expect(interval?.scheduleStartDate).toBe(START_DATE);

  const monthly = saved.get("UAT Monthly");
  expect(monthly?.frequencyType).toBe("monthly");
  expect(monthly?.monthKind).toBe("date");
  expect(monthly?.monthDay).toBe(15);

  const cycle = saved.get("UAT Cycle");
  expect(cycle?.frequencyType).toBe("cyclical");
  expect(cycle?.cycleDaysOn).toBe(21);
  expect(cycle?.cycleDaysOff).toBe(7);
  expect(cycle?.cycleAnchorDate).toBe(START_DATE);

  const asNeeded = saved.get("UAT As Needed");
  expect(asNeeded?.frequencyType).toBe("as_needed");
  expect(asNeeded?.scheduleTimes ?? []).toEqual([]);
});
