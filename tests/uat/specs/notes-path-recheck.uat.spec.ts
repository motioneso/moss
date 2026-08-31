import { execFileSync } from "node:child_process";

import { expect, test, type APIResponse, type Page } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// #1512 live-path proof (Coordinator-approved scope, plan addendum relay 8):
//   (a) legitimate in-root create/edit/delete/sync succeeds via real chat.
//   (b) rejectSymlinkParent (write-tools.ts:124-141, pre-existing ancestor-dir lstat check, NOT
//       part of #1512's fix) refuses live: an ancestor directory of the target path is itself a
//       symlink.
//   (c') the #1512 fix itself — recheckInside -> recheckWithinRoot -> canonicalizeAsFarAsExists
//       (packages/notes/src/path-guard.ts) — refuses live on a kernel-vs-lexical divergence: a
//       leaf symlink (`b.md -> "S/../evil.md"`) whose target text only escapes the root once "S"
//       is dereferenced to the REAL directory it points at (kernel order), not when ".." is
//       cancelled lexically against the literal text "S" (which would land back in-root). This is
//       tests/integration/notes.test.ts:98-105's case, made live. `outside` must be a real
//       existing directory for the divergence to be genuine — see that test's comment.
//   jobs.ts's collectMarkdownFiles readdir->realpath TOCTOU sliver is explicitly OUT of scope
//   here (no deterministic live trigger) — proven separately by re-running the integration suite.

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);
const POLL_DEADLINE_MS = 60_000;
// The notes-sync worker cold-loads its embedding model on first use in a fresh UAT container
// (observed: "dtype not specified for model" landing right as a 60s deadline expired) — give the
// indexing poll more headroom than the fast provider/model-availability polls above.
const SYNC_POLL_DEADLINE_MS = 180_000;
const NOTES_ROOT = `/data/vaults/${UAT_ADMIN_ID}`;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

function requireProjectName(): string {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return projectName;
}

async function readJson(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function ensureRealChat(page: Page): Promise<void> {
  const install = (await readJson(
    await page.request.post("/api/onboarding/provider-install", {
      data: { providerKind: "anthropic" }
    })
  )) as { installState?: string };
  expect(install.installState).toBe("installed");

  const login = (await readJson(
    await page.request.post("/api/onboarding/provider-login/begin", {
      data: { providerKind: "anthropic" }
    })
  )) as { status?: string };
  expect(login.status).toBe("ready");

  let chatModelId: string | undefined;
  await expect
    .poll(
      async () => {
        const body = (await readJson(await page.request.get("/api/ai/models"))) as {
          models: readonly {
            id: string;
            capabilities: readonly string[];
            status: string;
          }[];
        };
        chatModelId = body.models.find(
          (model) => model.status === "active" && model.capabilities.includes("chat")
        )?.id;
        return Boolean(chatModelId);
      },
      { timeout: POLL_DEADLINE_MS, message: "no active chat-capable model became available" }
    )
    .toBe(true);

  await readJson(
    await page.request.put("/api/ai/services/chat/binding", {
      data: { binding: { kind: "model", modelId: chatModelId } }
    })
  );

  await expect
    .poll(
      async () => {
        const body = (await readJson(await page.request.get("/api/ai/capability-route/chat"))) as {
          route: { available: boolean };
        };
        return body.route.available;
      },
      { timeout: POLL_DEADLINE_MS, message: "configured chat route did not become available" }
    )
    .toBe(true);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (testInfo.status === testInfo.expectedStatus || !projectName) return;
  try {
    const logs = execFileSync(
      "docker",
      buildUatComposeArgs(projectName, ["logs", "--tail", "2000", "jarv1s"]),
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    console.log(
      logs
        .split("\n")
        .filter(
          (line) =>
            !line.includes('"msg":"incoming request"') &&
            !line.includes('"msg":"request completed"')
        )
        .join("\n")
    );
  } catch {
    // Diagnostics only — never mask the real test failure with a logs error.
  }
});

test("notes write tools: in-root ops succeed, ancestor-symlink and lexical-escape attempts are refused live (#1512)", async ({
  page
}) => {
  test.skip(!REAL_CHAT_CONFIGURED, "needs a real chat-capable provider — #1121");
  // Raised from 300s alongside SYNC_POLL_DEADLINE_MS — the notes-last-sync poll alone can now
  // wait up to 180s, leaving too little headroom for the rest of the flow at the old ceiling.
  test.setTimeout(420_000);

  const projectName = requireProjectName();
  const stamp = Date.now();

  await signIn(page);
  await readJson(await page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } }));
  await ensureRealChat(page);

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  const chatDialog = page.getByRole("dialog", { name: "Chat with Moss" });

  // --- (a) legitimate in-root create / edit / delete succeed, and create syncs ------------
  const legitPath = `uat/notes-path-recheck-${stamp}.md`;
  const syncNotBefore = Date.now();
  await composer.fill(
    `Use the notes.create tool with path set to exactly "${legitPath}" and content set to exactly: ` +
      "Path recheck baseline. Do not ask a follow-up question."
  );
  await composer.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Executed: notes.create" })).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  let lastSyncBody: unknown;
  try {
    await expect
      .poll(
        async () => {
          const body = (await readJson(await page.request.get("/api/me/notes-last-sync"))) as {
            lastSync: { at: string | null; ingested: number; errors: number } | null;
          };
          lastSyncBody = body;
          const completedAt = body.lastSync?.at ? Date.parse(body.lastSync.at) : 0;
          return (
            completedAt >= syncNotBefore &&
            body.lastSync!.ingested > 0 &&
            body.lastSync!.errors === 0
          );
        },
        { timeout: SYNC_POLL_DEADLINE_MS, message: "created note was not indexed" }
      )
      .toBe(true);
  } catch (error) {
    // Distinguish "still syncing" (errors:0, just slow) from a real ingestion failure
    // (errors>0) — both otherwise read identically as a bare poll timeout.
    console.log(`notes-last-sync response at poll failure: ${JSON.stringify(lastSyncBody)}`);
    throw error;
  }

  await composer.fill(
    `Use the notes.edit tool on path "${legitPath}": replace the exact text "baseline" with ` +
      '"baseline edited". Do not ask a follow-up question.'
  );
  await composer.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Executed: notes.edit" })).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  await composer.fill(
    `Use the notes.delete tool to delete path "${legitPath}". Do not ask a follow-up question.`
  );
  await composer.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Executed: notes.delete" })).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  // --- (b) rejectSymlinkParent: an ANCESTOR directory of the target is a symlink ----------
  // Pre-existing check (write-tools.ts:124-141), not part of #1512's fix, but in the approved
  // live-path scope: it must be shown to actually refuse via real chat, not just unit-tested.
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "jarv1s",
      "sh",
      "-c",
      `mkdir -p /tmp/uat-1512-b-target-${stamp} && ln -sfn /tmp/uat-1512-b-target-${stamp} ${NOTES_ROOT}/D-${stamp}`
    ]),
    { stdio: "inherit" }
  );

  // notes.create opts into the gateway's safe error path: this fixed, path-free guard message is
  // useful to the user and safe for the assistant to repeat.
  await composer.fill(
    `Use the notes.create tool with path set to exactly "D-${stamp}/x.md" and content set to ` +
      "exactly: should not be written. Do not ask a follow-up question."
  );
  await composer.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "path is not within the linked notes source" })
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  // --- (c') the #1512 guard itself: leaf symlink, kernel-vs-lexical ".." divergence -------
  // The opted-in notes.create tool exposes its fixed, path-free guard message.
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "jarv1s",
      "sh",
      "-c",
      `mkdir -p /tmp/uat-1512-c-outside-${stamp} && ` +
        `ln -sfn /tmp/uat-1512-c-outside-${stamp} ${NOTES_ROOT}/S-${stamp} && ` +
        `ln -sfn "S-${stamp}/../evil-${stamp}.md" ${NOTES_ROOT}/b-${stamp}.md`
    ]),
    { stdio: "inherit" }
  );

  await composer.fill(
    `Use the notes.create tool with path set to exactly "b-${stamp}.md" and content set to ` +
      "exactly: should not be written. Do not ask a follow-up question."
  );
  await composer.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "path is not within the linked notes source" })
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  // No host filesystem path (the vault volume path, or the /tmp escape target) is ever surfaced
  // to the browser — the HttpError message is a fixed, path-free string.
  const threadText = await chatDialog.innerText();
  expect(threadText).not.toMatch(/\/tmp\/|\/data\/vaults/);
});
