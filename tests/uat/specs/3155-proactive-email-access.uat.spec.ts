import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_PASSWORD,
  UAT_ADMIN_ID,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";

export const uatLevel = { level: "multi-user", without: [] } as const;
const ACCOUNT_A = "70000000-0000-4000-8000-000000003155";
const ACCOUNT_B = "70000000-0000-4000-8000-000000003156";

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

async function signIn(page: Page, email = UAT_ADMIN_EMAIL, password = UAT_ADMIN_PASSWORD) {
  await page.goto(env("JARVIS_UAT_BASE_URL"));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
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

async function accountRow(page: Page, accountId: string) {
  const response = await page.request.get("/api/connectors/accounts");
  expect(response.status()).toBe(200);
  const data = (await response.json()) as { accounts: { id: string }[] };
  const index = data.accounts.findIndex((account) => account.id === accountId);
  expect(index).toBeGreaterThanOrEqual(0);
  return page.locator(".acct").nth(index);
}

async function refresh(page: Page, expectedEnqueued: number) {
  // Advance the fixture past existing refresh cooldown without changing production policy.
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
  const cards = await page.request.get("/api/me/proactive-cards");
  expect(cards.status()).toBe(200);
  expect(((await cards.json()) as { cards: unknown[] }).cards).toEqual([]);
}

test("real access controls and API refresh reach the worker without selecting email cards (#3155)", async ({
  page,
  browser
}) => {
  test.setTimeout(240_000);
  sql(`INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
    VALUES ('${ACCOUNT_A}', 'google', '${UAT_ADMIN_ID}', ARRAY['https://www.googleapis.com/auth/gmail.modify'], 'active', '{}'),
           ('${ACCOUNT_B}', 'google', '${UAT_ADMIN_ID}', ARRAY['https://www.googleapis.com/auth/gmail.modify'], 'active', '{}');
    INSERT INTO app.email_messages (id, connector_account_id, owner_user_id, sender, recipients, subject, received_at, external_id)
    VALUES (gen_random_uuid(), '${ACCOUNT_A}', '${UAT_ADMIN_ID}', 'sender@example.test', '{}', 'UAT3155 urgent please reply: permitted', now(), 'uat3155-a'),
           (gen_random_uuid(), '${ACCOUNT_B}', '${UAT_ADMIN_ID}', 'sender@example.test', '{}', 'UAT3155 urgent please reply: sibling', now(), 'uat3155-b');`);
  await signIn(page);
  const settings = await page.request.patch("/api/me/proactive-monitoring-settings", {
    data: {
      enabled: true,
      quietHours: { enabled: false },
      sources: { email: { enabled: true } }
    }
  });
  expect(settings.status()).toBe(200);
  await refresh(page, 1);
  await page.goto(`${env("JARVIS_UAT_BASE_URL")}/settings?section=connections`);
  let sibling = await accountRow(page, ACCOUNT_B);
  const saved = page.waitForResponse(
    (r) => r.url().includes(`${ACCOUNT_B}/feature-grants`) && r.request().method() === "PUT"
  );
  await sibling
    .locator("label.jds-switch")
    .filter({ has: page.getByRole("checkbox", { name: "Email access" }) })
    .click();
  expect((await saved).status()).toBe(200);
  await expect(sibling.getByRole("checkbox", { name: "Email access" })).not.toBeChecked();
  await page.reload();
  sibling = await accountRow(page, ACCOUNT_B);
  await expect(sibling.getByRole("checkbox", { name: "Email access" })).not.toBeChecked();
  const grants = await page.request.get(`/api/connectors/accounts/${ACCOUNT_B}/feature-grants`);
  expect(grants.status()).toBe(200);
  expect(await grants.json()).toMatchObject({ email: false });
  await refresh(page, 1);

  const revoked = page.waitForResponse(
    (r) => r.url().endsWith(`${ACCOUNT_B}/revoke`) && r.request().method() === "POST"
  );
  await sibling.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  expect((await revoked).status()).toBe(200);
  const accounts = await page.request.get("/api/connectors/accounts");
  const accountState = (await accounts.json()) as { accounts: { id: string; status: string }[] };
  expect(accountState.accounts.find((account) => account.id === ACCOUNT_B)?.status).toBe("revoked");
  expect(accountState.accounts.find((account) => account.id === ACCOUNT_A)?.status).toBe("active");
  await refresh(page, 1);

  await page.goto(`${env("JARVIS_UAT_BASE_URL")}/settings?section=modules`);
  // Email is a required built-in. Respect that policy instead of inventing a disable control.
  await expect(page.getByRole("checkbox", { name: "Use Email", exact: true })).toHaveCount(0);
  const disabled = await page.request.patch("/api/me/modules/email", { data: { disabled: true } });
  expect(disabled.status()).toBe(409);
  await refresh(page, 1);

  await page.goto(`${env("JARVIS_UAT_BASE_URL")}/today`);
  await expect(page.getByRole("region", { name: "Proactive monitoring" })).toHaveCount(0);
  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await signIn(second, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
    const foreignGrant = await second.request.put(
      `/api/connectors/accounts/${ACCOUNT_A}/feature-grants`,
      { data: { email: false } }
    );
    expect(foreignGrant.status()).toBe(404);
    const cards = await second.request.get("/api/me/proactive-cards");
    expect(((await cards.json()) as { cards: unknown[] }).cards).toEqual([]);
  } finally {
    await secondContext.close();
  }
  console.log(
    "[3155] UI grant off + revoke; required module disable409; authenticated refresh 1/1/1/1; real worker success cursor; quiet radar; foreign grant denied. Selection counts are verified separately at the real DB/provider seam."
  );
});
