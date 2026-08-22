// tests/uat/specs/1252-audit-truth-livepath.uat.spec.ts
//
// #1252 live-path proof, previously blocked on #1659 (the scripted-chat provider could never
// execute a real tool call; see that issue's root-cause writeup). #1659 is now fixed on main
// (PR #1687 gives the scripted provider its own PATH var), so this spec can finally drive the
// real thing: a real chat turn calls tasks.updateStatus with a taskId that does not exist.
// Tasks' own handler (packages/tasks/src/tools.ts taskUpdateStatusExecute) does not throw for
// that input — it returns `{ error: "Task not found" }` inside an otherwise-ok result. Before
// #1252, the gateway recorded that as a "success" audit row. After #1252, gateway.ts's
// isModuleReportedError check must mark it "failed" instead. That failure is a real, reachable
// UI surface: apps/web/src/settings/settings-activity-pane.tsx renders exactly this audit row
// with a red "Failed" badge.
//
// tasks.updateStatus is risk:"write" under the "task_changes" family. That family's manifest
// default is "ask_each_time", but tasks is a required, always-on module, so it never runs the
// install-time enable step that would otherwise set that preference. Instead, the very first use
// of any task-changes tool grants it standing trust automatically, without ever asking the user
// (packages/tasks/src/action-policy.ts TasksCompatibilityHelper, wired into #1311's install-grant
// system). tests/uat/specs/1311-install-grant.uat.spec.ts already proves this is the intended,
// shipped behaviour — a confirmation card must NOT appear here. This spec waits for the
// assistant's reply text instead, then checks the audit trail.
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// withoutNewsJsonBinding: true is load-bearing (see tests/uat/specs/1533-chat-surface-live-path.
// uat.spec.ts's header for the full story): without it, admin+data's default AI-provider seeding
// plus this spec's own scripted-chat provider leaves two active admin-owned assistant providers
// and no default, so chat has no usable model and Enter never sends a turn at all.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1252-audit-truth-livepath"
} as const;

const FAKE_TASK_ID = "99999999-9999-4999-8999-999999999252";
const CHAT_MESSAGE = "Please mark task UAT-1252-AUDIT-TRUTH as done.";
const CARD = '[role="region"][aria-label="Action request"]';

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
  readonly toolName?: string;
  readonly outcome?: string;
  readonly errorClass?: string | null;
}

async function fetchAuditLog(page: Page): Promise<readonly AuditLogEntry[]> {
  const response = await page.request.get("/api/ai/action-audit?limit=25");
  expect(response.ok(), `action-audit -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { entries: readonly AuditLogEntry[] }).entries;
}

test("a module-reported tool failure is recorded and shown as Failed, not Success (#1252)", async ({
  page
}) => {
  test.setTimeout(300_000);

  await test.step("sign in", async () => {
    await signIn(page);
  });

  await test.step("ask the assistant to update a task that does not exist", async () => {
    await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await composer.fill(CHAT_MESSAGE);
    await composer.press("Enter");
  });

  await test.step("the call runs on standing trust, with no confirmation card, and replies", async () => {
    // task_changes carries standing trust from first use (see the file header), so
    // tasks.updateStatus must run straight through. Asserting the card's absence, not just the
    // reply's presence, is what would catch a regression that started asking again.
    await expect(page.locator(CARD)).toHaveCount(0);
    await expect(
      page.getByText("I tried to mark that task done."),
      "the assistant's reply must reach the chat transcript"
    ).toBeVisible({ timeout: 60_000 });
  });

  await test.step("the audit log records this call as failed, not success", async () => {
    await expect
      .poll(
        async () => {
          const entries = await fetchAuditLog(page);
          return entries.find(
            (e) => e.toolName === "tasks.updateStatus" && e.errorClass === "module_reported"
          )?.outcome;
        },
        {
          timeout: 30_000,
          message: "no tasks.updateStatus audit row with errorClass=module_reported appeared"
        }
      )
      .toBe("failed");
  });

  await test.step("the real Activity pane shows this call as Failed, with no reload", async () => {
    await openActivityPane(page);
    const row = page.locator(".aud__row", { hasText: "tasks.updateStatus" }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("Failed", { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  await test.step("confirm the underlying task genuinely does not exist (sanity check)", async () => {
    const response = await page.request.get(`/api/tasks/${FAKE_TASK_ID}`);
    expect(response.status(), "the scripted taskId must be a real 404, not a stand-in").toBe(404);
  });
});
