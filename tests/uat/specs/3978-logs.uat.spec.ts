import { execFileSync } from "node:child_process";
import { createConnectorSecretCipher } from "@moss/connectors";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import {
  UAT_ADMIN_ID,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_ID,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";
import {
  bringUpRealChatModel,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";

// #3978 slice 2D: two-process live proof for the logs section. Real instance, real chat, no
// intercepted or rewritten responses. The worker warning comes from a real Google sync job that
// finds an unreadable stored connection, planted directly in the database as the setup step.

export const uatLevel = { level: "multi-user", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
const TURN_DEADLINE_MS = 300_000;
// Owner A (the admin) and owner B (the second user) get warnings with different text, so a chat
// answer shows whose text escaped.
const WORKER_WARNING = "google-sync stored connection invalid";
const SECOND_OWNER_WARNING = "google-sync auth failed";
const SECOND_ACCOUNT_ID = "70000000-0000-4000-8000-000000003979";
const NOTIFY_WARNING = "upgrade notification write failed";
const ADMIN_ACCOUNT_ID = "70000000-0000-4000-8000-000000003978";
const PLANTED_SECRET = "sk-uat3978-planted-secret-token-0001";

// A well-formed encrypted envelope that the instance key cannot open. The key id carries the
// planted secret, so the decrypt error text names it and only the log cleaner keeps it out.
const BROKEN_ENVELOPE = JSON.stringify({
  version: 1,
  algorithm: "aes-256-gcm",
  keyId: PLANTED_SECRET,
  iv: "AAAAAAAAAAAAAAAA",
  tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAA"
});

type LogRecord = {
  readonly component: string;
  readonly message: string | null;
  readonly owned: boolean;
  readonly ownerKnown: boolean;
};

function sql(statement: string): string {
  const project = requireUatProjectName();
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
    { encoding: "utf8", maxBuffer: 256 * 1024 }
  ).trim();
}

/**
 * Leaves the owner with exactly one account of this provider family, the planted one, so a sync
 * job cannot pick a seeded account and produce the same warning without the planted envelope.
 */
// A connection the stack key can open, with credentials Google will refuse. The worker decrypts
// it and fails later, at the token refresh, so its warning reads differently from the broken one.
const READABLE_ENVELOPE = JSON.stringify(
  createConnectorSecretCipher({
    JARVIS_CONNECTOR_SECRET_KEY: "00000000000000000000000000000000"
  }).encryptJson({
    kind: "google-oauth",
    clientId: "uat3978-client",
    clientSecret: "uat3978-client-secret",
    accessToken: "uat3978-access",
    refreshToken: "uat3978-refresh",
    tokenExpiry: "2000-01-01T00:00:00.000Z",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"]
  })
);

function plantBrokenConnection(
  ownerId: string,
  accountId: string,
  providerId: "google" | "imap-fastmail",
  envelope: string = BROKEN_ENVELOPE
): void {
  const family = providerId === "google" ? "provider_id = 'google'" : "provider_id LIKE 'imap-%'";
  sql(`DELETE FROM app.connector_accounts WHERE owner_user_id='${ownerId}' AND ${family}`);
  sql(
    `INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
     VALUES ('${accountId}', '${providerId}', '${ownerId}', ARRAY['${providerId === "google" ? "https://www.googleapis.com/auth/gmail.modify" : "email.read"}'], 'active', '${envelope}'::jsonb)`
  );
  expect(
    sql(
      `SELECT count(*) FROM app.connector_accounts WHERE owner_user_id='${ownerId}' AND ${family}`
    )
  ).toBe("1");
}

function workerWarningCount(ownerId: string): number {
  return Number(
    sql(
      `SELECT count(*) FROM app.diagnostic_log_records WHERE process='worker' AND owner_user_id='${ownerId}' AND level >= 40`
    )
  );
}

/** Queues a job the way the scheduler would, straight into the job table. */
function enqueueJob(queue: string, data: Record<string, unknown>): void {
  sql(
    `INSERT INTO pgboss.job (name, data) VALUES ('${queue}', '${JSON.stringify(data).replace(/'/g, "''")}'::jsonb)`
  );
}

/** A database rule that rejects notification writes, with the planted secret in the error. */
function installNotificationBlock(): void {
  sql(
    `CREATE OR REPLACE FUNCTION app.uat3978_block() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'uat3978 notification blocked ${PLANTED_SECRET}'; END $f$`
  );
  sql(
    "CREATE TRIGGER uat3978_block_trigger BEFORE INSERT ON app.notifications FOR EACH ROW EXECUTE FUNCTION app.uat3978_block()"
  );
}

function removeNotificationBlock(): void {
  sql("DROP TRIGGER IF EXISTS uat3978_block_trigger ON app.notifications");
  sql("DROP FUNCTION IF EXISTS app.uat3978_block()");
}

async function waitForNewWorkerWarning(ownerId: string, before: number): Promise<void> {
  await expect
    .poll(() => workerWarningCount(ownerId), {
      timeout: 120_000,
      message: "the worker never stored its warning"
    })
    .toBeGreaterThan(before);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies();
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin: requireUatBaseURL() }
  });
  expect(response.ok(), `sign-in ${email} -> ${response.status()}`).toBeTruthy();
}

async function triggerWorkerWarning(request: APIRequestContext, ownerId: string): Promise<void> {
  const before = workerWarningCount(ownerId);
  const response = await request.post("/api/connectors/google/sync");
  expect(response.status()).toBe(202);
  await waitForNewWorkerWarning(ownerId, before);
}

async function readLogs(
  request: APIRequestContext
): Promise<{ records: LogRecord[]; redactions: string[] }> {
  const response = await request.post(
    "/api/ai/assistant-tools/settings.platformDiagnostics/invoke",
    { data: { input: { include: ["logs"], logs: { minLevel: "warn" } } } }
  );
  const text = await response.text();
  expect(response.ok(), `platformDiagnostics -> ${response.status()}: ${text}`).toBeTruthy();
  const result = (JSON.parse(text) as { invocation?: { result?: unknown } }).invocation?.result as {
    data?: Record<string, unknown>;
    logs?: { records?: LogRecord[] };
    redactions?: string[];
  };
  const root = (result.data ?? result) as {
    logs?: { records?: LogRecord[] };
    redactions?: string[];
  };
  return { records: root.logs?.records ?? [], redactions: root.redactions ?? [] };
}

async function ask(page: Page, text: string): Promise<string> {
  const composer = page.getByRole("textbox", { name: /^Message/ });
  if (!(await composer.isVisible())) {
    await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
    await expect(composer).toBeVisible();
  }
  const settled = page.waitForResponse(
    (r) => r.url().includes("/api/chat/turn") && r.request().method() === "POST",
    { timeout: TURN_DEADLINE_MS }
  );
  await composer.fill(text);
  await composer.press("Enter");
  const response = await settled;
  expect(response.ok(), `chat turn -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { reply?: string }).reply ?? "";
}

test("Moss reads both processes' warnings, hides other owners' text, and survives a restart", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured (JARVIS_UAT_REAL_CHAT_CONFIGURED)"
  );
  test.setTimeout(900_000);

  // 1. A real worker warning for each owner, with different text. The admin's comes from a Google
  //    sync job that cannot open its stored connection. The second user's comes from an IMAP sync
  //    job queued for a broken IMAP connection. Each owner has only the planted account.
  plantBrokenConnection(UAT_ADMIN_ID, ADMIN_ACCOUNT_ID, "google");
  await signInUatAdmin(page);
  await triggerWorkerWarning(page.request, UAT_ADMIN_ID);
  const adminCookies = await page.context().cookies();
  const secondBefore = workerWarningCount(UAT_SECOND_OWNER_ID);
  plantBrokenConnection(UAT_SECOND_OWNER_ID, SECOND_ACCOUNT_ID, "google", READABLE_ENVELOPE);
  enqueueJob("connectors.google-sync", {
    kind: "google-sync",
    actorUserId: UAT_SECOND_OWNER_ID,
    trigger: "schedule"
  });
  await waitForNewWorkerWarning(UAT_SECOND_OWNER_ID, secondBefore);
  const secondMessages = sql(
    `SELECT string_agg(message || ' | ' || context::text, E'\n') FROM app.diagnostic_log_records WHERE process='worker' AND owner_user_id='${UAT_SECOND_OWNER_ID}' AND level >= 40`
  );
  expect(secondMessages, "the second owner's stored worker warnings").toContain(
    SECOND_OWNER_WARNING
  );

  // 2. Admin asks in chat. The answer quotes the admin's own worker warning and nothing from the
  //    second owner, and the tool call called the diagnostics tool.
  await page.goto(requireUatBaseURL());
  const chatModel = await bringUpRealChatModel(page);
  const pinSecond = await page.request.put(`/api/admin/users/${UAT_SECOND_OWNER_ID}/ai-pin`, {
    data: { modelId: chatModel.id }
  });
  expect(pinSecond.ok(), "pinning the chat model for the second owner").toBeTruthy();
  const reply = await ask(page, "Why did my Google connection sync fail? What do the logs show?");
  expect(reply.toLowerCase()).toContain("stored connection invalid");
  expect(reply.toLowerCase()).not.toContain(SECOND_OWNER_WARNING);
  const activity = sql(
    `SELECT count(*) FROM app.chat_messages WHERE owner_user_id='${UAT_ADMIN_ID}' AND tool_metadata::text LIKE '%settings_platformDiagnostics%'`
  );
  expect(Number(activity)).toBeGreaterThan(0);

  // 3. Other-owner exclusion in chat. The admin asks about the second owner's mail connection
  //    and may learn that a record exists, but never its text.
  const otherReply = await ask(
    page,
    "Did any other user's email connection fail to sync? Quote the exact log line if you can see it."
  );
  expect(otherReply.toLowerCase()).not.toContain(SECOND_OWNER_WARNING);
  const adminView = await readLogs(page.request);
  const others = adminView.records.filter((r) => !r.owned && r.component === "worker");
  expect(others.length).toBeGreaterThan(0);
  expect(others.every((r) => r.message === null)).toBe(true);
  expect(others.some((r) => r.ownerKnown)).toBe(true);

  // 4. A non-admin asks in chat and gets neither owner's text. The server reports a redaction.
  await signIn(page, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
  sql(`UPDATE app.users SET is_instance_admin=false WHERE id='${UAT_SECOND_OWNER_ID}'`);
  await page.goto(requireUatBaseURL());
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  await skipSetup.waitFor({ state: "visible", timeout: 20_000 });
  await skipSetup.click();
  const plainReply = await ask(
    page,
    "Why did my email connection fail to sync? What do the server logs show?"
  );
  expect(plainReply.toLowerCase()).not.toContain(SECOND_OWNER_WARNING);
  expect(plainReply.toLowerCase()).not.toContain("stored connection invalid");
  const plainView = await readLogs(page.request);
  expect(plainView.records).toEqual([]);
  expect(plainView.redactions).toContain("logs");

  // 5. The store survives a restart of the API and worker, and chat still finds the admin's
  //    warning afterwards.
  await restartUatStack(requireUatProjectName(), requireUatBaseURL());
  await page.context().clearCookies();
  await page.context().addCookies(adminCookies);
  await page.goto(requireUatBaseURL());
  const afterRestartReply = await ask(
    page,
    "After the restart, what do the logs still show about my Google connection?"
  );
  expect(afterRestartReply.toLowerCase()).toContain("stored connection invalid");
  expect(afterRestartReply.toLowerCase()).not.toContain(SECOND_OWNER_WARNING);

  // 6. A real API warning carries the planted secret in its error text. The failing request
  //    echoes the unknown input key, so the secret reaches the logger inside an error object.
  await page.context().clearCookies();
  await page.context().addCookies(adminCookies);
  const echo = await page.request.post(
    "/api/ai/assistant-tools/settings.platformDiagnostics/invoke",
    {
      data: { input: { include: ["logs"], logs: { [PLANTED_SECRET]: 1 } } }
    }
  );
  expect(echo.ok()).toBeFalsy();
  await expect
    .poll(
      () =>
        sql(
          "SELECT count(*) FROM app.diagnostic_log_records WHERE process='api' AND message='Unhandled route error' AND occurred_at > now() - interval '2 minutes'"
        ),
      { timeout: 60_000, message: "the API never stored the warning that carried the secret" }
    )
    .not.toBe("0");

  // 7. A real worker warning carries the planted secret in its error text. An upgrade-notice job
  //    tries to write a notification, and a database rule rejects the write with a message that
  //    contains the secret. The worker logs that error text through its own logger.
  installNotificationBlock();
  try {
    const notifyBefore = Number(
      sql(
        `SELECT count(*) FROM app.diagnostic_log_records WHERE process='worker' AND message='${NOTIFY_WARNING}'`
      )
    );
    enqueueJob("system.upgrade-notify", {
      kind: "upgrade-notify",
      actorUserId: UAT_ADMIN_ID,
      version: "v0.0.0-uat3978"
    });
    await expect
      .poll(
        () =>
          Number(
            sql(
              `SELECT count(*) FROM app.diagnostic_log_records WHERE process='worker' AND message='${NOTIFY_WARNING}'`
            )
          ),
        { timeout: 120_000, message: "the worker never stored the warning that carried the secret" }
      )
      .toBeGreaterThan(notifyBefore);
  } finally {
    removeNotificationBlock();
  }

  // The stored worker row kept the error text and masked only the secret, so the error really
  // reached the worker logger. Neither the stored rows nor the output of either process may hold
  // the secret. A control row shows the detector sees a secret when one is present.
  const secretInRows = (process: "api" | "worker") =>
    Number(
      sql(
        `SELECT count(*) FROM app.diagnostic_log_records WHERE process='${process}' AND (message LIKE '%${PLANTED_SECRET}%' OR context::text LIKE '%${PLANTED_SECRET}%')`
      )
    );
  expect(
    Number(
      sql(
        `SELECT count(*) FROM app.diagnostic_log_records WHERE process='worker' AND message='${NOTIFY_WARNING}' AND context::text LIKE '%uat3978 notification blocked%'`
      )
    )
  ).toBeGreaterThan(0);
  const output = execFileSync(
    "docker",
    buildUatComposeArgs(requireUatProjectName(), [
      "logs",
      "--no-color",
      "--tail",
      "4000",
      "jarv1s"
    ]),
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const workerLines = output.split("\n").filter((line) => line.includes('"process":"worker"'));

  expect(
    Number(
      sql(
        `SELECT count(*) FROM app.diagnostic_log_records WHERE process='worker' AND message='${WORKER_WARNING}'`
      )
    )
  ).toBeGreaterThan(0);
  expect(workerLines.some((line) => line.includes(NOTIFY_WARNING))).toBe(true);
  expect(workerLines.some((line) => line.includes("uat3978 notification blocked"))).toBe(true);
  expect(secretInRows("worker")).toBe(0);
  expect(workerLines.some((line) => line.includes(PLANTED_SECRET))).toBe(false);

  expect(secretInRows("api")).toBe(0);
  expect(output).toContain("Unhandled route error");
  expect(output).not.toContain(PLANTED_SECRET);

  // Control: the same detector reports a row that does carry the secret.
  sql(
    `INSERT INTO app.diagnostic_log_records (process, level, component, message, occurred_at) VALUES ('worker', 40, 'worker', 'control ${PLANTED_SECRET}', now())`
  );
  expect(secretInRows("worker")).toBe(1);
  sql(`DELETE FROM app.diagnostic_log_records WHERE message='control ${PLANTED_SECRET}'`);
  expect(secretInRows("worker")).toBe(0);
});
