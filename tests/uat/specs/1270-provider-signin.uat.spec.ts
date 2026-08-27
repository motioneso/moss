import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1270/#1271: the live-path proof for the recovered 2026-07-19 settings/onboarding stack. This is
// provider sign-in UI, so `docs/DEVELOPMENT_STANDARDS.md` -> Live-Path Gate forbids merging on
// CI-green alone: the assembled path has to be walked through the real UI on a real instance.
//
// `solo-admin` (admin user, no data chunks) is the minimal level that yields an owner. It needs no
// seeded AI provider — the point is to ADD providers through the real Settings surface. A
// freshly-seeded owner still has first-run onboarding pending, so login lands on the wizard, which
// test 1 uses on purpose before test 2 skips past it.
export const uatLevel = { level: "solo-admin", without: [] } as const;

// The provisioned stack installs provider CLIs into the /data/cli-tools volume at runtime; a fresh
// stack's volume is empty and the operator contract JARVIS_HOST_CLIS is unset, so the API's
// presence probe (packages/ai/src/cli-availability.ts `command -v claude|codex|agy`) reports every
// CLI absent. Both #1270 sign-in affordances are therefore expected in their *fallback* form here,
// and each assertion below accepts either branch rather than pinning the one this stack happens to
// take — pinning it would make the spec fail the day the harness starts pre-installing a CLI.
const TERMINAL_PASSWORD = "uat-terminal-pw-1270";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Copied (not imported) from cli-terminal.uat.spec.ts:24-42 — importing across spec files would
// also register that file's top-level test() calls here. Real nav only, no page.goto beyond the one
// unavoidable initial load: apps/web/src/app.tsx gates every route behind a 401 check, so a
// goto("/settings") shortcut would silently skip that fail-closed check instead of exercising it.
async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button with the
  // same accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
}

// From the wizard to the app shell. Skipping without a connected provider raises a confirmation
// ("chat won't work until one is connected"); confirm it. Idempotent against the shared, non-reset
// UAT DB: if a prior spec already dismissed onboarding, login lands straight on the shell.
async function skipOnboarding(page: Page): Promise<void> {
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

// Nav path mirrors cli-terminal.uat.spec.ts:49-52: usermenu -> Settings & permissions -> Admin /
// Setup (segmented control) -> the "Assistant & AI" admin section. Personal mode has a section of
// the SAME label, but settings-page.tsx only ever mounts one mode's nav group at a time, so the
// button reference is unambiguous once Admin / Setup has been selected.
async function openAssistantAndAiSettings(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Assistant & AI" }).click();
}

// `exact` is required throughout the provider picker: getByRole's name match is substring-based by
// default, so a bare "OpenAI" would also match the "OpenAI-compatible" entry (a strict-mode
// violation) and "Anthropic" would match the "Remove Anthropic" icon button.
async function addProviderFromPicker(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByText("Add a provider")).toBeVisible();
  await page.getByRole("button", { name: label, exact: true }).click();
}

// The Live-Path Gate wants screenshots on the PR, not just a green tick, so this spec captures the
// decisive frames deliberately rather than relying on Playwright's failure-only artifacts
// (playwright.uat.config.ts sets no `screenshot` option, so the default is "off"). outputPath keeps
// them inside the run's own test-results directory.
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

function providerCard(page: Page, displayName: string) {
  // The per-card Remove button's aria-label is the only guaranteed-unique handle inside a card.
  return page.locator(".prov").filter({ has: page.getByLabel(`Remove ${displayName}`) });
}

// #1270 headline: the first-run wizard must offer every CLI provider, not Claude alone. On `main`
// the presentation allowlist ONBOARDING_LOGINABLE_PROVIDER_KINDS = ["anthropic"]
// (packages/settings/src/repository.ts) hid the other two, so this step rendered a single card; the
// recovered f5b44c52 lifts it to ["anthropic","openai-compatible","google"]. The labels come from
// cli-auth-step.tsx PROVIDER_LABELS. #2027 renamed the google label "Antigravity" -> "Gemini":
// the pinned recipe installs Google's Gemini command-line tool, and "Antigravity" named a tool
// this project no longer installs.
test("first-run wizard offers Claude, Codex and Gemini — not Claude alone (#1270)", async ({
  page
}) => {
  await signIn(page);

  // FOUNDER_ORDER is welcome -> cliAuth -> connectors -> finish (onboarding-wizard.tsx:19), so the
  // assistant step is one advance away. The wizard renders the same advance button in both its top
  // and bottom nav, hence .first().
  await page.getByRole("button", { name: "Start setup" }).first().click();

  const providerNames = page.locator(".onb-cli__name");
  await expect(providerNames).toHaveCount(3);
  await expect(providerNames).toHaveText(["Claude", "Codex", "Gemini"]);
  await shot(page, "01-wizard-three-cli-providers");
});

// #1270's Settings half:
//   f5b44c52 — the picker's authMethod passthrough. Asserted here on its CLI branch; the api_key
//     branch is covered separately below by the #1325 test, since the two shipped in different
//     issues.
//   d05fca6c — a CLI provider added post-onboarding gets a REAL sign-in path. On `main` the CLI
//     block's button was a no-op that fired a "Re-authenticated with the … CLI" toast and did
//     nothing at all.
//   8ca91c82 — the in-app terminal's selected text is copyable (Ben: "I also can't copy from the
//     terminal in jarvis btw").
test("Settings offers CLI sign-in per provider and copies terminal text (#1270)", async ({
  page
}) => {
  // The config's 60s default is sized for a single interaction; this walk adds a provider, opens an
  // edit pane, starts a real server-side login, then sets up + unlocks the terminal and drives a
  // PTY round-trip across a container boundary.
  test.setTimeout(150_000);
  await signIn(page);
  await skipOnboarding(page);
  await openAssistantAndAiSettings(page);
  await expect(page.getByText("No providers yet")).toBeVisible();

  // --- A CLI catalog entry yields a CLI provider (the passthrough's cli branch).
  await addProviderFromPicker(page, "Anthropic");
  const anthropic = providerCard(page, "Anthropic");
  await expect(anthropic.locator(".prov__auth")).toHaveText("Anthropic CLI");

  // --- d05fca6c: a real sign-in path from Settings, in whichever form this stack's CLI presence
  // probe dictates. "Log in" (automated) appears in the card actions only when the CLI is present;
  // the CLI block inside Edit always offers one of the two, and BOTH open a real dialog. On `main`
  // neither existed: the only button there was the dead "Re-authenticate" toast.
  // `exact` again, for a different reason than the picker: model auto-discovery has by now filled the
  // card with per-model rows whose edit buttons are aria-labelled "Edit Claude", "Edit Claude Haiku
  // 4.5" and "Edit Claude Opus 4.8" (mdl__edit-btn), so a substring "Edit" matches all four.
  await anthropic.getByRole("button", { name: "Edit", exact: true }).click();
  const automated = anthropic.getByRole("button", { name: "Re-authenticate" });
  const viaTerminal = anthropic.getByRole("button", { name: "Use terminal to sign in" });
  await expect(automated.or(viaTerminal)).toBeVisible();
  await shot(page, "02-settings-cli-provider-signin-affordance");

  const usesAutomatedLogin = await automated.isVisible();
  if (usesAutomatedLogin) {
    await automated.click();
    // settings-provider-login-dialog.tsx aria-label = `${displayName} sign-in`.
    const loginDialog = page.getByRole("dialog", { name: "Anthropic sign-in" });
    await expect(loginDialog).toBeVisible();
    await expect(loginDialog.getByText("Sign in to Anthropic")).toBeVisible();
    // The flow STARTS on open (beginLogin), so it lands in one of: awaiting-token (paste a code),
    // awaiting-authorization/polling (device code), error (no authenticated CLI on this stack).
    // Any of those proves a real server round-trip rather than main's cosmetic toast. Assert the
    // union rather than one phase — which one depends on the provider CLI's own state, which the
    // harness does not control.
    await expect(
      loginDialog
        .getByLabel("Provider sign-in code")
        .or(loginDialog.getByText("Device code:"))
        .or(loginDialog.getByRole("alert"))
        .first()
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, "03-provider-login-dialog-started");
    await loginDialog.getByRole("button", { name: "Close" }).click();
    await expect(loginDialog).not.toBeAttached();
  } else {
    // Fallback path: the CLI block hands off to the owner-gated terminal, which is where the
    // provider's own `claude login` / `codex login` prints its device code or URL.
    await viaTerminal.click();
  }

  // --- 8ca91c82: terminal text is selectable and copyable. Reached via the fallback click above,
  // or via the card's Terminal action when the automated path was taken.
  if (usesAutomatedLogin) {
    await anthropic.getByRole("button", { name: "Terminal" }).click();
  }
  const terminal = page.getByRole("dialog", { name: "Anthropic terminal" });
  await expect(terminal).toBeVisible();

  // First run: no terminal password set yet (terminal-modal.tsx set-password phase). This is a
  // dedicated step-up password, separate from the account password.
  await terminal.getByLabel("New terminal password").fill(TERMINAL_PASSWORD);
  await terminal.getByLabel("Confirm terminal password").fill(TERMINAL_PASSWORD);
  await terminal.getByRole("button", { name: "Set password" }).click();
  // Password-set transitions straight to the locked phase. `exact` is required: getByLabel does
  // case-insensitive SUBSTRING matching, so a bare "Terminal password" also matches the set-phase
  // "New terminal password"/"Confirm terminal password" fields while the two phases briefly
  // co-exist during the transition — a strict-mode violation.
  await terminal.getByLabel("Terminal password", { exact: true }).fill(TERMINAL_PASSWORD);
  await terminal.getByRole("button", { name: "Unlock" }).click();

  const termHost = terminal.locator(".term-modal__host");
  await expect(termHost).toBeVisible();

  // The copy button is always rendered in the live phase but disabled until xterm reports a
  // selection (term.onSelectionChange -> hasTerminalSelection). Its mere presence is already the
  // main-vs-branch difference; the enable transition proves it is wired to real selection state.
  const copyButton = terminal.getByRole("button", { name: "Copy selected text" });
  await expect(copyButton).toBeVisible();
  await expect(copyButton).toBeDisabled();

  // Put known text on screen first — a selection over blank rows yields an empty string, and
  // xterm's onSelectionChange would report hasSelection() false. `echo` + a sentinel exercises the
  // full byte bridge (keystroke -> node-pty -> WebSocket -> term.write) without depending on any
  // provider CLI binary being installed in this stack.
  await termHost.click();
  await page.keyboard.type("echo __JARVIS_COPY_OK__");
  await page.keyboard.press("Enter");
  // xterm@6's default DomRenderer paints each row as real DOM text under .xterm-rows, so the echoed
  // sentinel is assertable text. Generous timeout: this round-trips across a real container
  // boundary in the provisioned stack.
  await expect(termHost.locator(".xterm-rows")).toContainText("__JARVIS_COPY_OK__", {
    timeout: 15_000
  });

  // Drag-select across the rendered rows. xterm owns mouse selection on .xterm-screen, so a real
  // pointer drag is the only way to produce a selection from the outside — there is no handle to
  // the Terminal instance in the page.
  const screen = termHost.locator(".xterm-screen");
  const box = await screen.boundingBox();
  if (!box) throw new Error("xterm screen has no bounding box");
  await page.mouse.move(box.x + 4, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect(copyButton).toBeEnabled();
  await shot(page, "04-terminal-copy-enabled-on-selection");

  await terminal.getByRole("button", { name: "Close" }).click();
  await expect(terminal).not.toBeAttached();
});

// #1325: an api_key catalog entry (Mistral here) used to fire createAiProvider immediately with no
// credentialPayload, and the server's fail-closed guard (packages/ai/src/routes.ts:759) 400'd every
// attempt — the picker showed an error toast and added nothing. settings-ai-admin-pane.tsx now
// branches the picker's onClick on authMethod: api_key opens an inline credential form and only
// creates once a key is entered. Fable-verified: the create route soft-fails discovery (routes.ts
// ~199-214, try/catch), so a fake key still yields a created, rendered provider card even though it
// can never really authenticate — this is expected on a UAT stack with no live Mistral credential.
test("Settings collects an API key before creating a picker provider (#1325)", async ({ page }) => {
  await signIn(page);
  await skipOnboarding(page);
  await openAssistantAndAiSettings(page);

  await addProviderFromPicker(page, "Mistral");

  // Still just the form: no provider has been created yet. `exact: true` is required: the same
  // Admin / Setup settings page also mounts the voice and web-search groups' own "...API key"
  // fields (settings-voice-config-group.tsx, settings-web-search-key-group.tsx), and getByLabel's
  // default substring match would otherwise catch those too (strict-mode violation).
  const apiKeyField = page.getByLabel("API key", { exact: true });
  await expect(apiKeyField).toBeVisible();
  const addButton = page.getByRole("button", { name: "Add", exact: true });
  await expect(addButton).toBeDisabled();
  await shot(page, "05-picker-api-key-credential-form");

  await apiKeyField.fill("sk-uat-fake-key-1325");
  await expect(addButton).toBeEnabled();
  await addButton.click();

  const mistral = providerCard(page, "Mistral");
  await expect(mistral).toBeVisible();
  // hasCredential is NOT NULL on a non-cli provider — no "No credential" branch to fall into.
  await expect(mistral.locator(".prov__auth")).toContainText("API key stored");
  await shot(page, "06-picker-api-key-provider-created");
});
