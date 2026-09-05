// tests/uat/specs/2175-activity-outcomes.uat.spec.ts
//
// #2175 Task 7 live-path proof for PR #2191: the Settings > Activity pane
// (apps/web/src/settings/settings-activity-pane.tsx) must show the two new audit outcomes with
// their plain-English labels — "Skipped (already covered)" for `suppressed` and "Refused (too
// many requests)" for `refused` — and must show how long a call took, from the new duration_ms
// column (packages/ai/sql/0210, 0211).
//
// The rows are seeded by the UAT harness's own seed service (tests/uat/seed/chunks/ai.ts
// seedActivityOutcomeFixture, opted into via withActivityOutcomeFixture below) through the same
// repository write the gateway uses, under the admin's own data context. Postgres publishes no
// host port in the UAT stack, so a spec cannot write rows itself; the harness flag is the
// supported path. Modelled on 1252-audit-truth-livepath.uat.spec.ts (same sign-in, same pane
// navigation).
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { UAT_ACTIVITY_OUTCOME_ROWS } from "../seed/chunks/ai.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withActivityOutcomeFixture: true
} as const;

const SUPPRESSED_LABEL = "Skipped (already covered)";
const REFUSED_LABEL = "Refused (too many requests)";
// 1234 ms renders as "took 1.2 s" (settings-activity-pane.tsx durationLabel).
const SUCCESS_DURATION_LABEL = "took 1.2 s";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

async function openActivityPane(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
}

interface AuditLogEntry {
  readonly id?: string;
  readonly outcome?: string;
  readonly durationMs?: number | null;
}

test("Activity shows the suppressed and refused outcomes and how long a call took (#2175)", async ({
  page
}) => {
  test.setTimeout(180_000);

  await test.step("sign in", async () => {
    await signIn(page);
  });

  await test.step("the audit API returns the three seeded rows with their outcome and duration", async () => {
    const response = await page.request.get("/api/ai/action-audit?limit=25");
    expect(response.ok(), `action-audit -> ${response.status()}`).toBeTruthy();
    const { entries } = (await response.json()) as { entries: readonly AuditLogEntry[] };
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get(UAT_ACTIVITY_OUTCOME_ROWS.suppressed.id)?.outcome).toBe("suppressed");
    expect(byId.get(UAT_ACTIVITY_OUTCOME_ROWS.refused.id)?.outcome).toBe("refused");
    const success = byId.get(UAT_ACTIVITY_OUTCOME_ROWS.success.id);
    expect(success?.outcome).toBe("success");
    expect(success?.durationMs, "duration_ms must reach the API response").toBe(
      UAT_ACTIVITY_OUTCOME_ROWS.success.durationMs
    );
  });

  await test.step("the real Activity pane shows both new labels and the duration", async () => {
    await openActivityPane(page);

    const suppressedRow = page
      .locator(".aud__row", { hasText: UAT_ACTIVITY_OUTCOME_ROWS.suppressed.toolName })
      .first();
    await expect(suppressedRow).toBeVisible({ timeout: 15_000 });
    await expect(suppressedRow.getByText(SUPPRESSED_LABEL, { exact: true })).toBeVisible();

    const refusedRow = page
      .locator(".aud__row", { hasText: UAT_ACTIVITY_OUTCOME_ROWS.refused.toolName })
      .first();
    await expect(refusedRow).toBeVisible();
    await expect(refusedRow.getByText(REFUSED_LABEL, { exact: true })).toBeVisible();

    const successRow = page
      .locator(".aud__row", { hasText: UAT_ACTIVITY_OUTCOME_ROWS.success.toolName })
      .first();
    await expect(successRow).toBeVisible();
    await expect(successRow.getByText("Done", { exact: true })).toBeVisible();
    await expect(
      successRow.getByText(SUCCESS_DURATION_LABEL, { exact: true }),
      "the recorded duration must be rendered on the row"
    ).toBeVisible();
  });
});
