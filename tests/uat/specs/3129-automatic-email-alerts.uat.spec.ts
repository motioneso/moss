import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "multi-user", without: [] } as const;
const ACCOUNT = "70000000-0000-4000-8000-000000003129";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be supplied by the isolated UAT runner`);
  return value;
}

function sql(statement: string): string {
  const project = env("JARVIS_UAT_PROJECT_NAME");
  if (!/^uat-[a-zA-Z0-9_-]+$/.test(project)) throw new Error("Disposable UAT project required");
  return execFileSync(
    "docker",
    buildUatComposeArgs(project, [
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
    ]),
    { encoding: "utf8", maxBuffer: 64 * 1024 }
  ).trim();
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

async function accountRow(page: Page) {
  const response = await page.request.get("/api/connectors/accounts");
  expect(response.status()).toBe(200);
  const data = (await response.json()) as { accounts: { id: string }[] };
  const index = data.accounts.findIndex((account) => account.id === ACCOUNT);
  expect(index).toBeGreaterThanOrEqual(0);
  return page.locator(".acct").nth(index);
}

async function recoverAccessLoads(page: Page, choice: ReturnType<Page["getByRole"]>) {
  sql("REVOKE SELECT ON app.connector_accounts FROM jarvis_app_runtime");
  try {
    const failedAccounts = page.waitForResponse(
      (response) => response.url().endsWith("/api/connectors/accounts") && response.status() >= 500
    );
    await page.reload();
    expect((await failedAccounts).status()).toBeGreaterThanOrEqual(500);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  } finally {
    sql("GRANT SELECT ON app.connector_accounts TO jarvis_app_runtime");
  }
  const retriedAccounts = page.waitForResponse(
    (response) => response.url().endsWith("/api/connectors/accounts") && response.status() === 200
  );
  await page.getByRole("button", { name: "Try again" }).click();
  expect((await retriedAccounts).status()).toBe(200);
  await expect(choice).toBeChecked();
}

test("owner Settings saves automatic email alerts without changing unrelated choices (#3129)", async ({
  page
}) => {
  test.setTimeout(240_000);
  sql(`INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
    VALUES ('${ACCOUNT}', 'google', '${UAT_ADMIN_ID}', ARRAY['https://www.googleapis.com/auth/gmail.modify'], 'active', '{}');
    INSERT INTO app.email_messages (id, connector_account_id, owner_user_id, sender, recipients, subject, received_at, external_id)
    VALUES (gen_random_uuid(), '${ACCOUNT}', '${UAT_ADMIN_ID}', 'sender@example.test', '{}', 'UAT3129 automatic alert', now(), 'uat3129-email');`);

  await signIn(page);
  await page.goto(`${env("JARVIS_UAT_BASE_URL")}/settings?section=alerts`);
  const choice = page.getByRole("checkbox", { name: "Automatic email alerts" });
  const choiceSwitch = page.locator("label.jds-switch").filter({ has: choice });
  await expect(choice).toBeChecked();
  expect(
    sql(
      `SELECT value_json ? 'automaticEmailAlerts' AND NOT value_json ? 'quietHours' AND NOT value_json ? 'sources' FROM app.preferences WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = 'proactive.monitoring.v1'`
    )
  ).toBe("t");

  const mutedModule = await page.request.put("/api/me/notification-preferences/briefings", {
    data: { enabled: false }
  });
  expect(mutedModule.status()).toBe(200);
  const registeredDevice = await page.request.post("/api/notifications/push/subscriptions", {
    data: {
      endpoint: "https://push.example.test/send/uat3129",
      keys: {
        p256dh:
          "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
        auth: "tBHItJI5svbpez7KI4CCXg"
      }
    }
  });
  expect(registeredDevice.status()).toBe(200);
  const modulesBefore = await page.request.get("/api/me/notification-preferences");
  expect(modulesBefore.status()).toBe(200);
  const modulePreferences = await modulesBefore.json();
  const devicesBefore = await page.request.get("/api/notifications/push/config");
  expect(devicesBefore.status()).toBe(200);
  const devicePreferences = await devicesBefore.json();
  expect((devicePreferences as { enabledDevices: unknown[] }).enabledDevices).toHaveLength(1);

  const setCalendar = await page.request.patch("/api/me/proactive-monitoring-settings", {
    data: { sources: { calendar: { enabled: true, dailyCardCap: 2 } } }
  });
  expect(setCalendar.status()).toBe(200);
  const digestBefore = await page.request.get("/api/me/notification-digest-preference");
  expect(digestBefore.status()).toBe(200);
  const digest = await digestBefore.json();

  await recoverAccessLoads(page, choice);

  const savedOff = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/proactive-monitoring-settings") &&
      response.request().method() === "PATCH"
  );
  await choiceSwitch.click();
  expect((await savedOff).status()).toBe(200);
  await expect(choice).not.toBeChecked();
  await page.reload();
  await expect(choice).not.toBeChecked();
  expect(
    sql(
      `SELECT (value_json ->> 'automaticEmailAlerts') || ':' || (value_json #>> '{sources,calendar,enabled}') || ':' || (value_json #>> '{sources,calendar,dailyCardCap}') FROM app.preferences WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = 'proactive.monitoring.v1'`
    )
  ).toBe("false:true:2");
  await refresh(page, 0);

  const savedOn = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/proactive-monitoring-settings") &&
      response.request().method() === "PATCH"
  );
  await choiceSwitch.click();
  expect((await savedOn).status()).toBe(200);
  await page.reload();
  await expect(choice).toBeChecked();
  await refresh(page, 1);
  const digestAfter = await page.request.get("/api/me/notification-digest-preference");
  expect(digestAfter.status()).toBe(200);
  expect(await digestAfter.json()).toEqual(digest);
  const modulesAfter = await page.request.get("/api/me/notification-preferences");
  expect(modulesAfter.status()).toBe(200);
  expect(await modulesAfter.json()).toEqual(modulePreferences);
  const devicesAfter = await page.request.get("/api/notifications/push/config");
  expect(devicesAfter.status()).toBe(200);
  expect(await devicesAfter.json()).toEqual(devicePreferences);

  await page.goto(`${env("JARVIS_UAT_BASE_URL")}/settings?section=connections`);
  const account = await accountRow(page);
  const revoked = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${ACCOUNT}/revoke`) && response.request().method() === "POST"
  );
  await account.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  expect((await revoked).status()).toBe(200);
  await page.goto(`${env("JARVIS_UAT_BASE_URL")}/settings?section=alerts`);
  await expect(choice).toBeChecked();
  await expect(
    page.getByText("An email connection was revoked. Your alert choice is saved.")
  ).toBeVisible();
  await refresh(page, 1);
  expect(
    sql(
      `SELECT last_checked_at IS NOT NULL AND cursor_json = '{}'::jsonb AND last_error_class IS NULL AND failure_count = 0 FROM app.proactive_monitor_state WHERE owner_user_id = '${UAT_ADMIN_ID}' AND source = 'email'`
    )
  ).toBe("t");
  expect(
    sql(
      `SELECT count(*) FROM app.proactive_cards WHERE owner_user_id = '${UAT_ADMIN_ID}' AND source = 'email'`
    )
  ).toBe("0");

  sql(`UPDATE app.preferences SET value_json = '{"version":1,"broken":true}'::jsonb
    WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = 'proactive.monitoring.v1'`);
  const failedSave = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/proactive-monitoring-settings") &&
      response.request().method() === "PATCH"
  );
  await choiceSwitch.click();
  expect((await failedSave).status()).toBe(409);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(choice).toBeChecked();

  sql(`UPDATE app.preferences SET value_json = '{"version":1,"automaticEmailAlerts":true,"sources":{"calendar":{"enabled":true,"dailyCardCap":2}},"updatedAt":"2026-10-08T00:00:00.000Z"}'::jsonb
    WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = 'proactive.monitoring.v1'`);
  const retriedSave = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/proactive-monitoring-settings") &&
      response.request().method() === "PATCH"
  );
  await page.getByRole("button", { name: "Try again" }).click();
  expect((await retriedSave).status()).toBe(200);
  await expect(choice).not.toBeChecked();
  expect(
    sql(
      `SELECT (value_json ->> 'automaticEmailAlerts') || ':' || (value_json #>> '{sources,calendar,enabled}') || ':' || (value_json #>> '{sources,calendar,dailyCardCap}') FROM app.preferences WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = 'proactive.monitoring.v1'`
    )
  ).toBe("false:true:2");

  console.log(
    "[3129] Settings initialized sparse intent; a real account-list load failure recovered locally; UI off/on/reload gated a real worker; calendar, module, device, and digest choices stayed independent; revoked access queued but the worker completed with no email-card output; malformed saved data produced a real 409 and retry saved the retained choice."
  );
});
