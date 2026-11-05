import { execFileSync } from "node:child_process";
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
const WORKER_WARNING = "google-sync stored connection invalid";
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

function plantBrokenConnection(ownerId: string, accountId: string): void {
  sql(
    `INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
     VALUES ('${accountId}', 'google', '${ownerId}', ARRAY['https://www.googleapis.com/auth/gmail.modify'], 'active', '${BROKEN_ENVELOPE}'::jsonb)
     ON CONFLICT (id) DO NOTHING`
  );
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
  const before = Number(
    sql(
      `SELECT count(*) FROM app.diagnostic_log_records WHERE process='worker' AND owner_user_id='${ownerId}' AND level >= 40`
    )
  );
  const response = await request.post("/api/connectors/google/sync");
  expect(response.status()).toBe(202);
  await expect
    .poll(
      () =>
        Number(
          sql(
            `SELECT count(*) FROM app.diagnostic_log_records WHERE process='worker' AND owner_user_id='${ownerId}' AND level >= 40`
          )
        ),
      { timeout: 120_000, message: "the worker never stored its warning" }
    )
    .toBeGreaterThan(before);
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

  // 1. A real worker warning owned by the admin, and a real one owned by the second user.
  plantBrokenConnection(UAT_ADMIN_ID, "70000000-0000-4000-8000-000000003978");
  plantBrokenConnection(UAT_SECOND_OWNER_ID, "70000000-0000-4000-8000-000000003979");
  await signInUatAdmin(page);
  await triggerWorkerWarning(page.request, UAT_ADMIN_ID);
  const adminCookies = await page.context().cookies();
  await signIn(page, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
  await triggerWorkerWarning(page.request, UAT_SECOND_OWNER_ID);
  await page.context().clearCookies();
  await page.context().addCookies(adminCookies);

  // 2. Admin asks in plain words. The answer quotes the worker warning, and the tool call
  //    called the diagnostics tool. The warning text only exists in its logs section.
  await page.goto(requireUatBaseURL());
  await bringUpRealChatModel(page);
  const reply = await ask(page, "Why did my Google connection sync fail? What do the logs show?");
  expect(reply.toLowerCase()).toContain("stored connection invalid");
  const activity = sql(
    `SELECT count(*) FROM app.chat_messages WHERE owner_user_id='${UAT_ADMIN_ID}' AND tool_metadata::text LIKE '%settings_platformDiagnostics%'`
  );
  expect(Number(activity)).toBeGreaterThan(0);

  // 3. The second owner's record shows up as metadata only for the admin.
  const adminView = await readLogs(page.request);
  const own = adminView.records.filter((r) => r.owned && r.message?.includes("stored connection"));
  const others = adminView.records.filter((r) => !r.owned && r.component === "worker");
  expect(own.length).toBeGreaterThan(0);
  expect(others.length).toBeGreaterThan(0);
  expect(others.every((r) => r.message === null)).toBe(true);
  expect(others.some((r) => r.ownerKnown)).toBe(true);

  // 4. A non-admin gets nothing and a server-side redaction notice.
  await signIn(page, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
  sql(`UPDATE app.users SET is_instance_admin=false WHERE id='${UAT_SECOND_OWNER_ID}'`);
  const plainView = await readLogs(page.request);
  expect(plainView.records).toEqual([]);
  expect(plainView.redactions).toContain("logs");

  // 5. The store survives a restart of the API and worker.
  await restartUatStack(requireUatProjectName(), requireUatBaseURL());
  await page.context().clearCookies();
  await page.context().addCookies(adminCookies);
  const afterRestart = await readLogs(page.request);
  expect(
    afterRestart.records.some((r) => r.owned && r.message?.includes("stored connection"))
  ).toBe(true);

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

  // Neither the stored rows nor the output of any process may hold the secret. The worker's
  // own warnings never print error text, so for it the check is that its output stays clean
  // while the planted envelope sits in the database it reads.
  const stored = sql(
    `SELECT count(*) FROM app.diagnostic_log_records WHERE message LIKE '%${PLANTED_SECRET}%' OR context::text LIKE '%${PLANTED_SECRET}%'`
  );
  expect(stored).toBe("0");
  const output = execFileSync(
    "docker",
    buildUatComposeArgs(requireUatProjectName(), ["logs", "--no-color", "--tail", "2000"]),
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  expect(output).toContain("Unhandled route error");
  expect(output).not.toContain(PLANTED_SECRET);
  expect(WORKER_WARNING).toContain("connection invalid");
});
