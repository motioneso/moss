import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "multi-user", without: [] } as const;
const ACCOUNT = "70000000-0000-4000-8000-000000003146";
const LEGACY_KEY = "email:uat3146-legacy-finding";
const PREF = `FROM app.preferences WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = 'proactive.monitoring.v1'`;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be supplied by the isolated UAT runner`);
  return value;
}

function compose(args: readonly string[]): string {
  const project = env("JARVIS_UAT_PROJECT_NAME");
  if (!/^uat-[a-zA-Z0-9_-]+$/.test(project)) throw new Error("Disposable UAT project required");
  return execFileSync("docker", buildUatComposeArgs(project, [...args]), {
    encoding: "utf8",
    maxBuffer: 64 * 1024
  }).trim();
}

function sql(statement: string): string {
  return compose([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "jarv1s",
    "-tAc",
    statement
  ]);
}

async function signIn(page: Page) {
  await page.goto(env("JARVIS_UAT_BASE_URL"));
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  await expect(skip.or(page.locator(".jds-usermenu__trigger")).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    const confirm = page.getByRole("button", { name: "Skip anyway" });
    if (await confirm.isVisible()) await confirm.click();
  }
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

/** Runs a real email scan through the worker and waits for it to finish cleanly. */
async function refresh(page: Page, expectedEnqueued: number) {
  sql(
    `DELETE FROM app.proactive_monitor_state WHERE owner_user_id = '${UAT_ADMIN_ID}' AND source = 'email'`
  );
  const response = await page.request.post("/api/me/proactive-cards/refresh");
  expect(response.status()).toBe(202);
  expect(await response.json()).toEqual({ enqueued: expectedEnqueued });
  if (expectedEnqueued) {
    await expect
      .poll(
        () =>
          sql(
            `SELECT count(*) FROM app.proactive_monitor_state WHERE owner_user_id = '${UAT_ADMIN_ID}' AND source = 'email' AND last_checked_at IS NOT NULL AND last_error_class IS NULL`
          ),
        { timeout: 45_000 }
      )
      .toBe("1");
  }
}

function savedChoices(): string {
  return sql(
    `SELECT (value_json ->> 'automaticEmailAlerts') || ':' || (value_json ->> 'dailyCardCap') || ':' || (value_json #>> '{sources,email,dailyCardCap}') ${PREF}`
  );
}

function charges(): string {
  return sql(
    `SELECT coalesce(string_agg(stable_key, ',' ORDER BY stable_key), '') FROM app.proactive_email_finding_charges WHERE owner_user_id = '${UAT_ADMIN_ID}'`
  );
}

async function toggle(page: Page, choiceSwitch: ReturnType<Page["locator"]>) {
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/proactive-monitoring-settings") &&
      response.request().method() === "PATCH"
  );
  await choiceSwitch.click();
  expect((await saved).status()).toBe(200);
}

test("saved email alert choices and a small saved limit survive reload and restart (#3146)", async ({
  page
}) => {
  test.setTimeout(300_000);

  // A connected mailbox with one real synced email, and one finding selected before this run.
  sql(`INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
    VALUES ('${ACCOUNT}', 'google', '${UAT_ADMIN_ID}', ARRAY['https://www.googleapis.com/auth/gmail.modify'], 'active', '{}');
    INSERT INTO app.email_messages (id, connector_account_id, owner_user_id, sender, recipients, subject, received_at, external_id)
    VALUES (gen_random_uuid(), '${ACCOUNT}', '${UAT_ADMIN_ID}', 'sender@example.test', '{}', 'UAT3146 monitored email', now(), 'uat3146-email');
    INSERT INTO app.proactive_email_finding_charges (owner_user_id, stable_key, charged_at)
    VALUES ('${UAT_ADMIN_ID}', '${LEGACY_KEY}', now() - interval '2 hours');`);

  await test.step("the upgrade left both alert tables owner-only", () => {
    expect(
      sql(
        `SELECT string_agg(relname || '=' || relrowsecurity || '/' || relforcerowsecurity, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relname IN ('proactive_cards', 'proactive_email_finding_charges')`
      )
    ).toBe("proactive_cards=true/true,proactive_email_finding_charges=true/true");
  });

  await signIn(page);
  await page.goto(`${env("JARVIS_UAT_BASE_URL")}/settings?section=alerts`);
  const choice = page.getByRole("checkbox", { name: "Automatic email alerts" });
  const choiceSwitch = page.locator("label.jds-switch").filter({ has: choice });

  await test.step("an absent record defaults on, and a small limit saves", async () => {
    await expect(choice).toBeChecked();
    const limit = await page.request.patch("/api/me/proactive-monitoring-settings", {
      data: { dailyCardCap: 2, sources: { email: { enabled: true, dailyCardCap: 1 } } }
    });
    expect(limit.status()).toBe(200);
    expect(savedChoices()).toBe("true:2:1");
  });

  await test.step("Settings saves off; it stays off after reload and no scan runs", async () => {
    await toggle(page, choiceSwitch);
    await expect(choice).not.toBeChecked();
    await page.reload();
    await expect(choice).not.toBeChecked();
    expect(savedChoices()).toBe("false:2:1");
    await refresh(page, 0);
  });

  await test.step("Settings saves on; the limit is kept and a real scan completes", async () => {
    await toggle(page, choiceSwitch);
    await page.reload();
    await expect(choice).toBeChecked();
    expect(savedChoices()).toBe("true:2:1");
    await refresh(page, 1);
    expect(charges()).toBe(LEGACY_KEY);
  });

  await test.step("after an app restart the choice, the limit and the earlier finding remain", async () => {
    compose(["restart", "jarv1s"]);
    await expect
      .poll(
        async () => {
          try {
            return (await page.request.get("/api/me/proactive-monitoring-settings")).status();
          } catch {
            return 0;
          }
        },
        { timeout: 120_000 }
      )
      .toBe(200);
    await page.reload();
    await expect(choice).toBeChecked();
    expect(savedChoices()).toBe("true:2:1");
    expect(charges()).toBe(LEGACY_KEY);
    expect(sql(`SELECT count(*) FROM app.schema_migrations WHERE version = '0312'`)).toBe("1");
    await refresh(page, 1);
    expect(charges()).toBe(LEGACY_KEY);
  });

  console.log(
    "[3146] Upgrade left both alert tables FORCE RLS; absent record defaulted on; a saved limit (global 2, email 1) and the off/on choice were saved through the real routes and survived reload and an app restart; real worker scans completed before and after restart; the earlier selected finding kept its single charge. No real email reaches the alert threshold, so the cap being hit is proven by the database tests (Ben's ruling)."
  );
});
