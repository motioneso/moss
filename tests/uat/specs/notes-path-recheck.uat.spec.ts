import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { captureActionAuditEvidence } from "./notes-failure-evidence.js";
import { startNewSideChat } from "./notes-new-side-chat.js";
import {
  bringUpRealChatProvider,
  discoverCheapestChatModel,
  readUatJson,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";

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

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
const POLL_DEADLINE_MS = 60_000;
// The notes-sync worker cold-loads its embedding model on first use in a fresh UAT container
// (observed: "dtype not specified for model" landing right as a 60s deadline expired) — give the
// indexing poll more headroom than the fast provider/model-availability polls above.
const SYNC_POLL_DEADLINE_MS = 180_000;
const NOTES_ROOT = `/data/vaults/${UAT_ADMIN_ID}`;

// This spec binds the chat capability directly (PUT /api/ai/services/chat/binding) rather than
// going through the account's chat-model-override, so it composes the shared provider bring-up
// and cheapest-model discovery instead of using bringUpRealChatModel wholesale.
async function ensureRealChat(page: Page): Promise<void> {
  await bringUpRealChatProvider(page);
  const cheapest = await discoverCheapestChatModel(page, POLL_DEADLINE_MS);

  await readUatJson(
    await page.request.put("/api/ai/services/chat/binding", {
      data: { binding: { kind: "model", modelId: cheapest.id } }
    })
  );

  await expect
    .poll(
      async () => {
        const body = (await readUatJson(
          await page.request.get("/api/ai/capability-route/chat")
        )) as { route: { available: boolean } };
        return body.route.available;
      },
      { timeout: POLL_DEADLINE_MS, message: "configured chat route did not become available" }
    )
    .toBe(true);
}

// The jarv1s service drops every capability but CHOWN, SETUID, SETGID, FOWNER and KILL, so root in
// a plain `exec` has no DAC override and cannot traverse the owner-only vault directory. Plant
// fixtures as the account that owns the vault root instead.
function execInVaultAsOwner(projectName: string, script: string): void {
  const owner = execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "jarv1s",
      "stat",
      "-c",
      "%u:%g",
      "/data/vaults"
    ]),
    { encoding: "utf8" }
  ).trim();
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, ["exec", "-T", "-u", owner, "jarv1s", "sh", "-c", script]),
    { stdio: "inherit" }
  );
}

async function expectToolOutcome(
  projectName: string,
  toolName: string,
  startedAt: number,
  outcome: "success" | "failed"
): Promise<void> {
  await expect
    .poll(
      () => {
        const evidence = captureActionAuditEvidence(
          execFileSync,
          projectName,
          UAT_ADMIN_ID,
          new Date(startedAt).toISOString(),
          new Date().toISOString()
        );
        return evidence.error === null
          ? evidence.entries
              .filter((entry) => entry.toolName === toolName)
              .map((entry) => entry.outcome)
          : [];
      },
      { timeout: 60_000, message: `${toolName} did not record ${outcome}` }
    )
    .toContain(outcome);
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

  const projectName = requireUatProjectName();
  const stamp = Date.now();

  await signInUatAdmin(page);
  await readUatJson(await page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } }));
  await ensureRealChat(page);

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  const chatDialog = page.getByRole("dialog", { name: "Chat with Moss" });
  const createFailures = chatDialog.getByRole("status").filter({
    hasText: "Create note didn’t go through · The app reported a problem."
  });
  const modelGuardReplies = chatDialog
    .locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble")
    .filter({ hasText: /path is not within the linked notes source/i });

  // --- (a) legitimate in-root create / edit / delete succeed, and create syncs ------------
  const legitPath = `uat/notes-path-recheck-${stamp}.md`;
  const createdNotes = chatDialog.getByRole("status").filter({ hasText: /^Done: Create note$/ });
  const createCount = await createdNotes.count();
  const syncNotBefore = Date.now();
  await composer.fill(
    `Use the notes.create tool with path set to exactly "${legitPath}" and content set to exactly: ` +
      "Path recheck baseline. Use these exact inputs without further questions."
  );
  await composer.press("Enter");
  await expect(createdNotes).toHaveCount(createCount + 1, { timeout: 60_000 });
  await expect(createdNotes.last()).toBeVisible();
  await expectToolOutcome(projectName, "notes.create", syncNotBefore, "success");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  let lastSyncBody: unknown;
  try {
    await expect
      .poll(
        async () => {
          const body = (await readUatJson(await page.request.get("/api/me/notes-last-sync"))) as {
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

  const editedNotes = chatDialog.getByRole("status").filter({ hasText: /^Done: Edit note$/ });
  const editCount = await editedNotes.count();
  const editNotBefore = Date.now();
  await composer.fill(
    `Use the notes.edit tool on path "${legitPath}": replace the exact text "baseline" with ` +
      '"baseline edited". Use these exact inputs without further questions.'
  );
  await composer.press("Enter");
  await expect(editedNotes).toHaveCount(editCount + 1, { timeout: 60_000 });
  await expect(editedNotes.last()).toBeVisible();
  await expectToolOutcome(projectName, "notes.edit", editNotBefore, "success");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  const deletedNotes = chatDialog.getByRole("status").filter({ hasText: /^Done: Delete note$/ });
  const deleteCount = await deletedNotes.count();
  const deleteNotBefore = Date.now();
  await composer.fill(
    `Use the notes.delete tool to delete path "${legitPath}". Use these exact inputs without further questions.`
  );
  await composer.press("Enter");
  await expect(deletedNotes).toHaveCount(deleteCount + 1, { timeout: 60_000 });
  await expect(deletedNotes.last()).toBeVisible();
  await expectToolOutcome(projectName, "notes.delete", deleteNotBefore, "success");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  // --- (b) rejectSymlinkParent: an ANCESTOR directory of the target is a symlink ----------
  // Pre-existing check (write-tools.ts:124-141), not part of #1512's fix, but in the approved
  // live-path scope: it must be shown to actually refuse via real chat, not just unit-tested.
  execInVaultAsOwner(
    projectName,
    `mkdir -p /tmp/uat-1512-b-target-${stamp} && ln -sfn /tmp/uat-1512-b-target-${stamp} ${NOTES_ROOT}/D-${stamp}`
  );

  // The quiet status reports failure; the model's own reply must also explain the guard.
  // Count matching replies before the turn so earlier assistant text cannot satisfy the check.
  const ancestorFailureCount = await createFailures.count();
  const ancestorReplyCount = await modelGuardReplies.count();
  const ancestorAttemptNotBefore = Date.now();
  await composer.fill(
    `Use the notes.create tool with path set to exactly "D-${stamp}/x.md" and content set to ` +
      "exactly: should not be written. Use these exact inputs without further questions."
  );
  await composer.press("Enter");
  await expectToolOutcome(projectName, "notes.create", ancestorAttemptNotBefore, "failed");
  await expect(createFailures).toHaveCount(ancestorFailureCount + 1, { timeout: 60_000 });
  await expect(createFailures.nth(ancestorFailureCount)).toBeVisible();
  await expect(modelGuardReplies.nth(ancestorReplyCount)).toBeVisible({ timeout: 60_000 });
  execInVaultAsOwner(projectName, `test ! -e /tmp/uat-1512-b-target-${stamp}/x.md`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  await expect(chatDialog.locator(".action-request-card")).toHaveCount(0);
  expect(await chatDialog.innerText()).not.toMatch(/\/tmp\/|\/data\/vaults/);

  // The safe tool error taints this conversation, so later writes correctly need approval.
  // Exercise the second guard independently in a fresh side chat from Conversations.
  await startNewSideChat(page, chatDialog);
  await expect(createFailures).toHaveCount(0);

  // --- (c') the #1512 guard itself: leaf symlink, kernel-vs-lexical ".." divergence -------
  // The fresh conversation must show its own failed-create outcome.
  execInVaultAsOwner(
    projectName,
    `mkdir -p /tmp/uat-1512-c-outside-${stamp} && ` +
      `ln -sfn /tmp/uat-1512-c-outside-${stamp} ${NOTES_ROOT}/S-${stamp} && ` +
      `ln -sfn "S-${stamp}/../evil-${stamp}.md" ${NOTES_ROOT}/b-${stamp}.md`
  );

  const leafFailureCount = await createFailures.count();
  const leafReplyCount = await modelGuardReplies.count();
  const leafAttemptNotBefore = Date.now();
  await composer.fill(
    `Use the notes.create tool with path set to exactly "b-${stamp}.md" and content set to ` +
      "exactly: should not be written. Use these exact inputs without further questions."
  );
  await composer.press("Enter");
  await expectToolOutcome(projectName, "notes.create", leafAttemptNotBefore, "failed");
  await expect(createFailures).toHaveCount(leafFailureCount + 1, { timeout: 60_000 });
  await expect(createFailures.nth(leafFailureCount)).toBeVisible();
  await expect(modelGuardReplies.nth(leafReplyCount)).toBeVisible({ timeout: 60_000 });
  execInVaultAsOwner(projectName, `test ! -e /tmp/evil-${stamp}.md`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  // Host paths stay out of the thread. The fixed guard explanation belongs in the model's
  // reply, while the quiet outcome keeps its generic failure wording.
  const threadText = await chatDialog.innerText();
  expect(threadText).not.toMatch(/\/tmp\/|\/data\/vaults/);
  const outcomeText = (await chatDialog.getByRole("status").allTextContents()).join("\n");
  expect(outcomeText).not.toContain("path is not within the linked notes source");
  await expect(chatDialog.locator(".action-request-card")).toHaveCount(0);
});
