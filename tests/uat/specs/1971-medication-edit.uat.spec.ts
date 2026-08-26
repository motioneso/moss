import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1971: a saved medication can now be edited, not just removed and re-added. This spec creates
// one medication as "Every day" through the real form, presses its Edit button, changes the
// schedule to Monthly and the name, saves, closes and reopens the modal, then reads the
// medication back from the real list endpoint to confirm the change landed as a PATCH rather
// than a new row. Nothing here is mocked: the browser drives the real modal and the real API.
export const uatLevel = { level: "admin+data", without: [] } as const;

const START_DATE = "2026-09-01";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors the sign-in in 1970-medication-builder.uat.spec.ts: admin+data stops before the
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

async function closeManageMedications(page: Page) {
  await page.locator(".wl-modal").getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".wl-modal")).toHaveCount(0);
}

interface SavedMedication {
  readonly name: string;
  readonly frequencyType: string;
  readonly monthKind: string | null;
  readonly monthDay: number | null;
}

async function readSavedMedications(page: Page): Promise<Map<string, SavedMedication>> {
  const response = await page.request.get(`${requireBaseURL()}/api/wellness/medications`);
  expect(response.ok(), `list medications -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { medications: SavedMedication[] };
  return new Map(body.medications.map((medication) => [medication.name, medication]));
}

test("editing a saved medication changes it in place, not by adding a new one (#1971)", async ({
  page
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openManageMedications(page);
  const modal = page.locator(".wl-modal");

  // 1. Create one medication as "Every day".
  await modal.getByLabel("Medication name", { exact: true }).fill("UAT Edit Me");
  await modal.getByLabel("Dose", { exact: true }).fill("10 mg");
  await modal.getByRole("button", { name: "Every day", exact: true }).click();
  await modal.getByLabel("Dose time 1", { exact: true }).fill("08:00");
  await modal.getByLabel("Start date", { exact: true }).fill(START_DATE);
  const addButton = modal.getByRole("button", { name: "Add medication" });
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(modal.locator(".wl-medrow__name", { hasText: "UAT Edit Me" })).toBeVisible();

  // 2. Press its Edit button — the form should switch to edit mode, prefilled from the saved row.
  await modal.getByRole("button", { name: "Edit UAT Edit Me" }).click();
  await expect(modal.getByText("Edit medication")).toBeVisible();
  await expect(modal.getByLabel("Medication name", { exact: true })).toHaveValue("UAT Edit Me");

  // 3. Change the schedule to Monthly, on the 15th, and rename it.
  await modal.getByRole("button", { name: "Monthly", exact: true }).click();
  await modal.getByRole("button", { name: "On a date" }).click();
  await modal.getByLabel("Day of the month", { exact: true }).fill("15");
  await modal.getByLabel("Dose time 1", { exact: true }).fill("09:00");
  await modal.getByLabel("Medication name", { exact: true }).fill("UAT Edited");

  // 4. Save.
  const saveButton = modal.getByRole("button", { name: "Save changes" });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(modal.locator(".wl-medrow__name", { hasText: "UAT Edited" })).toBeVisible();
  await expect(modal.locator(".wl-medrow__name", { hasText: "UAT Edit Me" })).toHaveCount(0);

  // 5. Close and reopen, then read the medication back from the real endpoint.
  await closeManageMedications(page);
  await openManageMedications(page);

  const saved = await readSavedMedications(page);
  expect(
    saved.has("UAT Edit Me"),
    "the old name should be gone, not left behind as a second row"
  ).toBe(false);
  const edited = saved.get("UAT Edited");
  expect(edited?.frequencyType).toBe("monthly");
  expect(edited?.monthKind).toBe("date");
  expect(edited?.monthDay).toBe(15);
});
