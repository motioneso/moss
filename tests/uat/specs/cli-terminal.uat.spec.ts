import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1059: the terminal is owner/admin-gated and needs no seeded module data — no chat provider,
// no job-search/news/etc chunk. `solo-admin` (admin user only, no data chunks) is the minimal
// level that gives us an owner. A freshly-seeded owner still has first-run onboarding pending,
// so login lands on the onboarding wizard, not the app shell — the test skips it below.
export const uatLevel = { level: "solo-admin", without: [] } as const;

// #1059/#1000: happy-path proof that the owner-gated CLI-provider terminal streams a real PTY
// end-to-end against a real, prod-shaped instance — no mocked API calls (playwright.uat.config.ts
// has no webServer/mocks; a mocked WebSocket, as tests/e2e/ uses, cannot exercise node-pty).
// Real nav only, no page.goto beyond the one unavoidable initial load: apps/web/src/app.tsx gates
// every route behind a 401 check, so a goto("/settings") shortcut would silently skip that
// fail-closed check instead of exercising it.
test("owner opens the CLI terminal, runs a command, sees output, closes clean", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);

  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button
  // with the same accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  // A freshly-seeded owner has first-run onboarding pending, so login lands on the onboarding
  // wizard (apps/web onboarding flow), not the app shell. Skip it to open the app — the terminal
  // is reached through Settings, which onboarding gates. This exercises the real skip path a
  // returning owner would take.
  await page.getByRole("button", { name: "Skip setup" }).click();
  // Skipping without a connected provider raises a confirmation dialog ("Skip setup without
  // connecting a provider?" — chat won't work until one is connected). Confirm to open the app.
  await page.getByRole("button", { name: "Skip anyway" }).click();

  // Proves login landed on the authenticated shell — RailUserMenu only renders once logged in.
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();

  // Nav path mirrors job-search-install.uat.spec.ts: usermenu -> Settings ->
  // Admin / Setup (segmented control) -> the "Assistant & AI" admin section. Personal mode has
  // a section of the SAME label ("Assistant & AI" -> AssistantPane), but settings-page.tsx only
  // ever mounts one mode's nav group at a time, so this button reference is unambiguous once
  // Admin / Setup has been selected.
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Assistant & AI" }).click();
  await expect(page.getByText("No providers yet")).toBeVisible();

  // A CLI-auth provider has no API key to test, so this instance needs one added before the
  // Terminal button exists (settings-ai-admin-pane.tsx's createMutation always creates with
  // authMethod: "cli" — no credential fields required, so this works with no real provider CLI
  // installed or authenticated in the provisioned instance).
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("button", { name: "Anthropic" }).click();
  await expect(page.getByText("No providers yet")).toBeHidden();

  await page.getByRole("button", { name: "Terminal" }).click();

  const dialog = page.getByRole("dialog", { name: "Anthropic terminal" });
  await expect(dialog).toBeVisible();

  // First run: no terminal password set yet (terminal-modal.tsx's set-password phase, gated by
  // getTerminalStatus). This is a dedicated step-up password, separate from the account password.
  await dialog.getByLabel("New terminal password").fill("uat-terminal-pw-1059");
  await dialog.getByLabel("Confirm terminal password").fill("uat-terminal-pw-1059");
  await dialog.getByRole("button", { name: "Set password" }).click();

  // Password-set transitions straight to the locked phase (nextTerminalModalPhase) — unlock with
  // the same password to request a WS ticket and mount the xterm surface. `exact` is required:
  // getByLabel does case-insensitive SUBSTRING matching, so a bare "Terminal password" also
  // matches the set-phase "New terminal password"/"Confirm terminal password" fields while the
  // two phases briefly co-exist during the transition — a strict-mode violation. The unlock
  // field's aria-label is exactly "Terminal password", so exact match waits for just it.
  await dialog.getByLabel("Terminal password", { exact: true }).fill("uat-terminal-pw-1059");
  await dialog.getByRole("button", { name: "Unlock" }).click();

  const termHost = dialog.locator(".term-modal__host");
  await expect(termHost).toBeVisible();

  // Drive the live PTY: type a shell builtin sentinel, NOT `claude --version` — the pane is a
  // plain bash shell and the provider CLI may not be installed/on-PATH in a provisioned
  // instance, so asserting on a real CLI's version output would be flaky. `echo` + the sentinel
  // exercises the full byte-bridge (keystroke -> node-pty -> WebSocket -> term.write) without
  // depending on any CLI binary being present.
  await termHost.click();
  await page.keyboard.type("echo __JARVIS_TERM_OK__");
  await page.keyboard.press("Enter");

  // xterm@6's default renderer is `DomRenderer` (xterm.js's `_createRenderer()` always
  // instantiates it — verified in apps/web/node_modules/@xterm/xterm/lib/xterm.js; there is no
  // canvas fallback in this version), which paints each row as real DOM text under a
  // `.xterm-rows` container rather than a canvas. That means the echoed sentinel is actual,
  // assertable text — no screenshot/OCR or screenReaderMode opt-in needed. Generous timeout:
  // this round-trips keystroke -> WS -> node-pty -> shell -> WS -> term.write, across a real
  // container boundary in the provisioned stack.
  await expect(termHost.locator(".xterm-rows")).toContainText("__JARVIS_TERM_OK__", {
    timeout: 15_000
  });

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeAttached();
  // #1059: a process-leak assertion (no orphan bash left behind) isn't reachable from the
  // browser — hard-kill-on-close is covered by the Task 3/4/7 server-side unit paths instead.
});
