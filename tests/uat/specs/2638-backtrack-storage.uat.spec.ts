// tests/uat/specs/2638-backtrack-storage.uat.spec.ts
//
// #2638 Backtrack phase 2a live proof (plan 2026-10-03-backtrack-phase2.md §7). On a real stack:
// seed Backtrack segments and their `screen` chunks for two people, turn the instance switch on,
// delete "Today" for the admin in the real Settings screen, then check in the database that only
// the admin's rows from today are gone, with their chunks, and that the other person's rows and
// the admin's older rows are untouched.
//
// Seeding and checking go through psql as the database superuser (the 2911 precedent): the point
// is what the real app's delete route did, so the check must not go through the app's own RLS.
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { buildUatComposeArgs } from "../provisioner.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const OTHER_USER_ID = "00000000-0000-4000-8000-000000002638";
const OTHER_USER_EMAIL = "backtrack-other@example.test";

function requireBaseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function requireProjectName(): string {
  const value = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!value) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return value;
}

function psql(projectName: string, sql: string): string {
  return execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-t",
      "-A",
      "-c",
      sql
    ]),
    { encoding: "utf8" }
  ).trim();
}

function count(projectName: string, sql: string): number {
  return Number(psql(projectName, sql));
}

/** One segment plus its `screen` chunk, started `ago` before now, for `owner`. */
function seedSegment(projectName: string, owner: string, label: string, ago: string): void {
  const id = psql(
    projectName,
    `INSERT INTO app.backtrack_segments
       (owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title, body,
        body_hash, client_started_at, indexed_at)
     VALUES ('${owner}', gen_random_uuid(), now() - interval '${ago}',
             now() - interval '${ago}' + interval '1 minute', 'Safari', 'com.apple.Safari',
             '${label}', '${label} body', decode(md5('${label}') || md5('${label}'), 'hex'),
             now() - interval '${ago}', now())
     RETURNING id`
  ).split(/\s/)[0];
  psql(
    projectName,
    `INSERT INTO app.memory_chunks
       (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
     VALUES ('${owner}', 'screen', 'backtrack/${id}', 0, 0, md5('${label}'), '${label} body')`
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.locator(".jds-usermenu__trigger");
  await expect(skip.or(menu).first()).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) {
    await skip.click();
    try {
      await page.getByRole("button", { name: "Skip anyway" }).click({ timeout: 5_000 });
    } catch {
      // No confirmation dialog on this instance.
    }
  }
  await expect(menu).toBeVisible({ timeout: 30_000 });
}

test("Delete today removes only the signed-in person's rows from today (#2638)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const projectName = requireProjectName();
  const baseURL = requireBaseURL();

  await signIn(page);

  const adminId = psql(projectName, `SELECT id FROM app.users WHERE email = '${UAT_ADMIN_EMAIL}'`);
  expect(adminId).toMatch(/^[0-9a-f-]{36}$/);

  await test.step("turn the instance switch on, as an admin", async () => {
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/admin/runtime-config/backtrack.storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "on" })
      });
      return response.status;
    });
    expect(status).toBe(200);
  });

  await test.step("seed segments and screen chunks for two people", async () => {
    psql(
      projectName,
      `INSERT INTO app.users (id, email, name, email_verified, is_instance_admin,
         is_bootstrap_owner, status)
       VALUES ('${OTHER_USER_ID}', '${OTHER_USER_EMAIL}', 'Other Person', true, false, false,
               'active')
       ON CONFLICT (id) DO NOTHING`
    );
    psql(
      projectName,
      `DELETE FROM app.backtrack_segments WHERE owner_user_id IN ('${adminId}', '${OTHER_USER_ID}')`
    );
    psql(
      projectName,
      `DELETE FROM app.memory_chunks WHERE source_kind = 'screen' AND owner_user_id IN ('${adminId}', '${OTHER_USER_ID}')`
    );
    seedSegment(projectName, adminId, "admin-today", "1 minute");
    seedSegment(projectName, adminId, "admin-older", "40 hours");
    seedSegment(projectName, OTHER_USER_ID, "other-today", "1 minute");
    expect(
      count(
        projectName,
        `SELECT count(*) FROM app.backtrack_segments WHERE owner_user_id IN ('${adminId}', '${OTHER_USER_ID}')`
      )
    ).toBe(3);
  });

  await test.step("the Settings screen shows the stored history and deletes today", async () => {
    await page.goto(`${baseURL}/settings?section=modules&module=backtrack`);
    await expect(page.getByRole("heading", { name: "Backtrack" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("37 days, plus up to one hourly run")).toBeVisible();
    await page.getByRole("button", { name: "Today" }).click();
    await expect(page.getByText(/Deleted 1 stored segment/)).toBeVisible({ timeout: 30_000 });
  });

  await test.step("only the admin's rows from today, and their chunks, are gone", async () => {
    const segmentsFor = (owner: string, label: string) =>
      count(
        projectName,
        `SELECT count(*) FROM app.backtrack_segments WHERE owner_user_id = '${owner}' AND window_title = '${label}'`
      );
    const chunksFor = (owner: string) =>
      count(
        projectName,
        `SELECT count(*) FROM app.memory_chunks WHERE owner_user_id = '${owner}' AND source_kind = 'screen'`
      );

    expect(segmentsFor(adminId, "admin-today")).toBe(0);
    expect(segmentsFor(adminId, "admin-older")).toBe(1);
    expect(segmentsFor(OTHER_USER_ID, "other-today")).toBe(1);
    expect(chunksFor(adminId)).toBe(1);
    expect(chunksFor(OTHER_USER_ID)).toBe(1);
    // The delete left a marker, so a late upload of the same time cannot bring the text back.
    expect(
      count(
        projectName,
        `SELECT count(*) FROM app.backtrack_deletions WHERE owner_user_id = '${adminId}'`
      )
    ).toBe(1);
  });

  await test.step("clean up the seeded rows", async () => {
    psql(
      projectName,
      `DELETE FROM app.backtrack_segments WHERE owner_user_id IN ('${adminId}', '${OTHER_USER_ID}')`
    );
    psql(
      projectName,
      `DELETE FROM app.memory_chunks WHERE source_kind = 'screen' AND owner_user_id IN ('${adminId}', '${OTHER_USER_ID}')`
    );
    psql(
      projectName,
      `DELETE FROM app.backtrack_deletions WHERE owner_user_id IN ('${adminId}', '${OTHER_USER_ID}')`
    );
    psql(projectName, `DELETE FROM app.users WHERE id = '${OTHER_USER_ID}'`);
  });
});
