import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Park Press check 7: a real multipage Wellness export. A fresh owner signs up through the real
// screen, creates disposable health records through the same endpoints the Wellness screens call,
// then generates the export through the real Export dialog and the real export worker. The
// downloaded file is copied to the evidence folder (outside the repo) and printed to PDF with the
// browser's own print engine so the pages can be inspected afterwards. No screenshots are taken.
export const uatLevel = { level: "bare", without: [] } as const;

const EVIDENCE_DIR = join(homedir(), ".coord-briefs", "park-press", "evidence");
const OWNER_EMAIL = "pp-owner-b@example.test";
const OWNER_PASSWORD = "ParkPress-b-7-2026!";
const OWNER_NAME = "Park Press Tester";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signUp(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible();
  await page.getByLabel("Name").fill(OWNER_NAME);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page
    .locator("form.auth-form")
    .getByRole("button", { name: /create/i })
    .click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

const CORES = ["happy", "sad", "fear", "anger", "disgust", "surprise"] as const;
const LONG_TOKEN = "supercalifragilisticexpialidocious".repeat(4);

function medicationNote(index: number): string {
  const sentence = `Medication ${index} note: take with food, avoid grapefruit, report dizziness to the prescriber. `;
  return `${sentence.repeat(7)}Line one ends here.\nSecond line for medication ${index} with an unbroken token ${LONG_TOKEN} and the final marker NOTE-END-${index}.`;
}

test("multipage Wellness export through the real screen and worker (check 7)", async ({ page }) => {
  test.setTimeout(420_000);
  await signUp(page);
  const base = requireBaseURL();

  await page.goto(`${base}/wellness`);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeVisible({
    timeout: 30_000
  });

  // Disposable records through the endpoints the Wellness screens call.
  const checkinCount = 45;
  for (let i = 1; i <= checkinCount; i += 1) {
    const response = await page.request.post(`${base}/api/wellness/checkins`, {
      data: {
        feelingCore: CORES[i % CORES.length],
        intensity: (i % 5) + 1,
        energy: ((i + 2) % 5) + 1,
        sensations: i % 3 === 0 ? ["tight chest", "restless"] : [],
        note: `Check-in ${i}: slept badly, long walk after lunch, mood shifted by evening. CHECKIN-END-${i}`
      }
    });
    expect(response.ok(), `checkin ${i} -> ${response.status()}`).toBeTruthy();
  }
  const medCount = 18;
  for (let i = 1; i <= medCount; i += 1) {
    const response = await page.request.post(`${base}/api/wellness/medications`, {
      data: {
        name: `Testmed ${String(i).padStart(2, "0")}`,
        dosage: `${i * 5} mg`,
        frequencyType: "once_daily",
        scheduleTimes: ["08:00"],
        notes: medicationNote(i)
      }
    });
    expect(response.ok(), `medication ${i} -> ${response.status()}`).toBeTruthy();
  }

  // The new records show on the real screen.
  await page.reload();
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeVisible();

  // Real Export dialog: choose categories (therapy notes selected but empty, insights left out).
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export for a clinician" });
  await expect(dialog).toBeVisible();
  const from = await dialog.getByLabel("From", { exact: true }).inputValue();
  const to = await dialog.getByLabel("To", { exact: true }).inputValue();
  await dialog.locator("label.jds-check", { hasText: "Insights" }).click();
  await expect(dialog.getByLabel("Insights")).not.toBeChecked();
  await expect(dialog.getByLabel("Mood check-ins")).toBeChecked();
  await expect(dialog.getByLabel("Medications & logs")).toBeChecked();
  await expect(dialog.getByLabel("Therapy notes")).toBeChecked();
  await expect(dialog.getByLabel("Insights")).not.toBeChecked();
  await dialog
    .locator("label.jds-check", { hasText: "This export will contain sensitive" })
    .click();
  await expect(dialog.getByLabel(/This export will contain sensitive/)).toBeChecked();
  const exportPost = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/wellness/export" && r.request().method() === "POST"
  );
  await dialog.getByRole("button", { name: "Generate export" }).click();
  const post = await exportPost;
  expect(post.ok(), `export POST -> ${post.status()}`).toBeTruthy();
  const posted = post.request().postDataJSON() as {
    categories: string[];
    from: string;
    to: string;
  };

  const download = dialog.getByRole("link", { name: "Download" });
  await expect(download).toBeVisible({ timeout: 90_000 });
  const href = await download.getAttribute("href");
  const jobId = href?.split("/").pop() ?? "unknown";
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const htmlPath = join(EVIDENCE_DIR, "check7-wellness-export.html");
  await file.saveAs(htmlPath);
  console.log(
    `[check7] job=${jobId} status=ready from=${from} to=${to} categories=${posted.categories.join(",")} file=${htmlPath}`
  );
  writeFileSync(
    join(EVIDENCE_DIR, "check7-export-job.json"),
    JSON.stringify(
      { jobId, status: "ready", requested: posted, uiFrom: from, uiTo: to, checkinCount, medCount },
      null,
      2
    )
  );

  // Print the actual output with the browser's own print engine (Chromium, A4, CSS page margin).
  const printPage = await page.context().newPage();
  await printPage.goto(`file://${htmlPath}`);
  await printPage.emulateMedia({ media: "print" });
  // The Schedule and State columns must stay readable beside the long notes.
  await printPage.emulateMedia({ media: "print" });
  const columns = await printPage.evaluate(() => {
    const row = document.querySelector("table thead tr");
    return Array.from(row?.querySelectorAll("th") ?? []).map((th) => ({
      text: th.textContent?.trim() ?? "",
      width: Math.round(th.getBoundingClientRect().width),
      height: Math.round(th.getBoundingClientRect().height)
    }));
  });
  console.log(`[check7] medication table header cells: ${JSON.stringify(columns)}`);
  const schedule = columns.find((c) => c.text === "Schedule");
  const state = columns.find((c) => c.text === "State");
  expect(schedule?.width ?? 0).toBeGreaterThanOrEqual(70);
  expect(state?.width ?? 0).toBeGreaterThanOrEqual(50);
  // A header that fits on one line is far shorter than a letter-by-letter wrap.
  expect(schedule?.height ?? 999).toBeLessThan(40);
  expect(state?.height ?? 999).toBeLessThan(40);
  await printPage.pdf({
    path: join(EVIDENCE_DIR, "check7-wellness-export.pdf"),
    format: "A4",
    preferCSSPageSize: true,
    printBackground: true
  });
  console.log("[check7] printed with Chromium page.pdf, format A4, preferCSSPageSize (@page 18mm)");
  await printPage.close();
});
