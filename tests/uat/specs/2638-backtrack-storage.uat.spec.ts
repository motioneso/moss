// tests/uat/specs/2638-backtrack-storage.uat.spec.ts
//
// #2638 Backtrack phase 2a live proof (plan 2026-10-03-backtrack-phase2.md §7). On a real stack:
// seed Backtrack segments and their `screen` chunks for two people, turn the instance switch on,
// delete "Today" for the admin in the real Settings screen, then check in the database that only
// the admin's rows from today are gone, with their chunks, and that the other person's rows and
// the admin's older rows are untouched.
//
// The second test is the assembled path #3029's review asked for: a stand-in for the Mac (this
// test's own HTTP client) pairs through the real pairing API and uploads through the real ingest
// route, the real worker indexes the text, and the person deletes Today, a day that hasn't begun
// and Everything in the real Settings screen. Re-sending each deleted batch proves the deletion
// markers hold. Phase 2b's Mac uploader will send the same requests; nothing here is mocked.
//
// Seeding and checking go through psql as the database superuser (the 2911 precedent): the point
// is what the real app's delete route did, so the check must not go through the app's own RLS.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

/**
 * One segment plus its `screen` chunk for `owner`. `ago` starts it that far before the
 * database's now; `startedAtMs` starts it at an exact instant (a browser-local time the test
 * resolved), so the sample always lands inside the day the Settings delete covers.
 */
function seedSegment(
  projectName: string,
  owner: string,
  label: string,
  ago: string,
  startedAtMs?: number
): void {
  const started =
    startedAtMs === undefined ? `now() - interval '${ago}'` : `to_timestamp(${startedAtMs / 1000})`;
  const id = psql(
    projectName,
    `INSERT INTO app.backtrack_segments
       (owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title, body,
        body_hash, client_started_at, indexed_at)
     VALUES ('${owner}', gen_random_uuid(), ${started},
             ${started} + interval '1 minute', 'Safari', 'com.apple.Safari',
             '${label}', '${label} body', decode(md5('${label}') || md5('${label}'), 'hex'),
             ${started}, now())
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
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
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
    // The "today" samples sit just after the browser-local midnight, not minutes before
    // now: the "Today" delete below covers midnight-to-now, so seeding relative to now would
    // place them yesterday on a run just past midnight and delete nothing (see #3034).
    const todayBase = await page.evaluate(() => {
      const midnight = new Date();
      midnight.setHours(0, 1, 0, 0);
      return midnight.getTime();
    });
    await expect.poll(() => Date.now(), { timeout: 180_000 }).toBeGreaterThan(todayBase);
    seedSegment(projectName, adminId, "admin-today", "1 minute", todayBase);
    seedSegment(projectName, adminId, "admin-older", "40 hours");
    seedSegment(projectName, OTHER_USER_ID, "other-today", "1 minute", todayBase);
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

interface UploadSegment {
  readonly startedAt: Date;
  readonly body: string;
}

interface UploadResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly discarded: number;
  readonly rejectedClock: number;
}

/** Pair a stand-in Mac through the real API; the signed-in page approves it like a person would. */
async function pairStandInMac(page: Page, baseURL: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const verifierHash = createHash("sha256").update(verifier).digest("base64url");
  const pair = await fetch(`${baseURL}/api/companion/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceName: "Backtrack UAT stand-in Mac",
      platform: "macos",
      appVersion: "1.0.0",
      osVersion: "26.0",
      verifierHash
    })
  });
  expect(pair.status).toBe(200);
  const { attemptId, approvalPath } = (await pair.json()) as {
    attemptId: string;
    approvalPath: string;
  };
  const code = new URLSearchParams(new URL(approvalPath, baseURL).hash.replace(/^#/, "")).get(
    "code"
  );
  expect(code).toBeTruthy();
  const decided = await page.evaluate(async (pairingCode) => {
    const response = await fetch("/api/companion/pair/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCode, decision: "approve" })
    });
    return response.status;
  }, code);
  expect(decided).toBe(200);
  const redeemed = await fetch(`${baseURL}/api/companion/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attemptId, verifier })
  });
  expect(redeemed.status).toBe(200);
  return ((await redeemed.json()) as { credential: string }).credential;
}

/** Upload one batch the way the Mac does: its clock in `sentAt`, every segment in its own clock. */
async function upload(
  baseURL: string,
  credential: string,
  segments: readonly UploadSegment[]
): Promise<UploadResult> {
  const response = await fetch(`${baseURL}/api/companion/backtrack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({
      sentAt: new Date().toISOString(),
      segments: segments.map((segment) => ({
        startedAt: segment.startedAt.toISOString(),
        endedAt: new Date(segment.startedAt.getTime() + 1_000).toISOString(),
        appName: "Safari",
        bundleId: "com.apple.Safari",
        windowTitle: "Backtrack UAT page",
        body: segment.body
      }))
    })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as UploadResult;
}

test("A Mac's uploads are indexed, deleted from Settings, and stay deleted on retry (#3029)", async ({
  page
}) => {
  test.setTimeout(600_000);
  const projectName = requireProjectName();
  const baseURL = requireBaseURL();

  await signIn(page);
  const adminId = psql(projectName, `SELECT id FROM app.users WHERE email = '${UAT_ADMIN_EMAIL}'`);
  expect(adminId).toMatch(/^[0-9a-f-]{36}$/);

  const segmentCount = () =>
    count(
      projectName,
      `SELECT count(*) FROM app.backtrack_segments WHERE owner_user_id = '${adminId}'`
    );
  const chunkCount = () =>
    count(
      projectName,
      `SELECT count(*) FROM app.memory_chunks WHERE owner_user_id = '${adminId}' AND source_kind = 'screen'`
    );
  const markerCount = () =>
    count(
      projectName,
      `SELECT count(*) FROM app.backtrack_deletions WHERE owner_user_id = '${adminId}'`
    );
  const waitForIndexed = async (expected: number) => {
    await expect
      .poll(chunkCount, { timeout: 240_000, intervals: [2_000] })
      .toBeGreaterThanOrEqual(expected);
  };
  const openSettings = async () => {
    await page.goto(`${baseURL}/settings?section=modules&module=backtrack`);
    await expect(page.getByRole("heading", { name: "Backtrack" })).toBeVisible({ timeout: 30_000 });
  };

  await test.step("turn the instance switch on and start from no Backtrack rows", async () => {
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/admin/runtime-config/backtrack.storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "on" })
      });
      return response.status;
    });
    expect(status).toBe(200);
    for (const table of ["backtrack_segments", "backtrack_deletions"]) {
      psql(projectName, `DELETE FROM app.${table} WHERE owner_user_id = '${adminId}'`);
    }
    psql(
      projectName,
      `DELETE FROM app.memory_chunks WHERE owner_user_id = '${adminId}' AND source_kind = 'screen'`
    );
  });

  const credential = await test.step("pair a stand-in Mac through the real API", () =>
    pairStandInMac(page, baseURL));

  // Anchor the samples just after the browser-local midnight instead of minutes before
  // now: the "Today" delete below covers midnight-to-now, so a run in the first minutes
  // after midnight would otherwise place both samples yesterday and delete nothing.
  // 00:01 is always inside today and inside the 26-hour upload age window. The samples
  // use the same spacing as the later ones below (second starts 1.5 s after the first, so
  // it ends at +2.5 s), and the wait runs past +3 s, so both have ended before the upload
  // arrives even on a run that reaches this step just past midnight.
  const morningBase = await page.evaluate(() => {
    const midnight = new Date();
    midnight.setHours(0, 1, 0, 0);
    return midnight.getTime();
  });
  await expect.poll(() => Date.now(), { timeout: 180_000 }).toBeGreaterThan(morningBase + 3_000);
  const morning: UploadSegment[] = [
    { startedAt: new Date(morningBase), body: "uat morning page one" },
    { startedAt: new Date(morningBase + 1_500), body: "uat morning page two" }
  ];

  await test.step("upload two segments; the worker indexes them into screen chunks", async () => {
    expect(await upload(baseURL, credential, morning)).toMatchObject({ accepted: 2 });
    expect(segmentCount()).toBe(2);
    await waitForIndexed(2);
  });

  await test.step("Settings deletes Today, with the chunks, and leaves a marker", async () => {
    await openSettings();
    await page.getByRole("button", { name: "Today" }).click();
    await expect(page.getByText("Deleted 2 stored segments.")).toBeVisible({ timeout: 30_000 });
    expect(segmentCount()).toBe(0);
    expect(chunkCount()).toBe(0);
    expect(markerCount()).toBe(1);
  });

  await test.step("the Mac re-sending that batch is discarded, not restored", async () => {
    expect(await upload(baseURL, credential, morning)).toMatchObject({
      accepted: 0,
      discarded: 2
    });
    expect(segmentCount()).toBe(0);
  });

  await test.step("the day picker stops at today, and a day not yet begun deletes nothing", async () => {
    await page.getByRole("button", { name: "Choose a day…" }).click();
    const picker = page.getByLabel("Day to delete");
    const [today, tomorrow] = await page.evaluate(() => {
      const value = (date: Date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const now = new Date();
      return [value(now), value(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))];
    });
    await expect(picker).toHaveAttribute("max", today);
    // The attribute only limits the browser's own picker; a typed value still reaches the server.
    await picker.fill(tomorrow);
    const response = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/backtrack/segments") &&
        candidate.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Delete that day" }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByText("Nothing was kept in that time.")).toBeVisible();
    expect(markerCount()).toBe(1);
  });

  // Segments captured after the Today delete start past its marker's end, so they're accepted.
  const markerEnd = new Date(
    psql(
      projectName,
      `SELECT to_char(upper(range) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM app.backtrack_deletions WHERE owner_user_id = '${adminId}'`
    )
  ).getTime();
  expect(Number.isNaN(markerEnd)).toBe(false);
  const later: UploadSegment[] = [
    { startedAt: new Date(markerEnd + 1_000), body: "uat afternoon page one" },
    { startedAt: new Date(markerEnd + 1_500), body: "uat afternoon page two" }
  ];
  // Each segment lasts a second and must have ended before the upload is received.
  await expect.poll(() => Date.now(), { timeout: 10_000 }).toBeGreaterThan(markerEnd + 3_000);

  await test.step("captures made after that delete are accepted and indexed", async () => {
    expect(await upload(baseURL, credential, later)).toMatchObject({ accepted: 2, discarded: 0 });
    await waitForIndexed(2);
  });

  await test.step("Settings deletes Everything after confirming", async () => {
    await openSettings();
    await page.getByRole("button", { name: "Everything…" }).click();
    await page.getByRole("button", { name: "Delete everything" }).click();
    await expect(page.getByText("Deleted 2 stored segments.")).toBeVisible({ timeout: 30_000 });
    expect(segmentCount()).toBe(0);
    expect(chunkCount()).toBe(0);
    expect(
      count(
        projectName,
        `SELECT count(*) FROM app.backtrack_deletions WHERE owner_user_id = '${adminId}' AND lower_inf(range)`
      )
    ).toBe(1);
  });

  await test.step("re-sending the deleted batch is discarded again", async () => {
    expect(await upload(baseURL, credential, later)).toMatchObject({
      accepted: 0,
      discarded: 2
    });
    expect(segmentCount()).toBe(0);
  });

  await test.step("clean up: no Backtrack rows, the switch off", async () => {
    psql(projectName, `DELETE FROM app.backtrack_deletions WHERE owner_user_id = '${adminId}'`);
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/admin/runtime-config/backtrack.storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "off" })
      });
      return response.status;
    });
    expect(status).toBe(200);
  });
});
