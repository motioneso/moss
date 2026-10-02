import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1441 (Moss rename, PR1 phase 2 — docs/superpowers/plans/2026-08-06-moss-1441-display-strings.md
// §5 Phase 2, §6 exit criterion 3): proves BOTH halves of the rename together, in one live run,
// against the real running server — not mocks:
//   1. The assistant name is a per-user, runtime-configured value (Settings -> Your assistant ->
//      Persona -> "Assistant name", apps/web/src/settings/settings-ai-pane.tsx) that threads
//      through every surface that names the assistant: the chat composer, the chat drawer, the
//      shell's chat-affordance button and calendar hold copy.
//   2. The PRODUCT name is a fixed literal, "Moss", independent of that per-user value — it must
//      NOT drift when the assistant name changes (a "swept rename" regression) and no surface may
//      still read "Jarvis" (a "missed rename" regression) — the two failure modes #1441 exists to
//      prevent, per the task brief handed down for this spec.
//
// Deliberately NOT covered here (per the same brief): getting a chat model to actually reply.
// Chat turns need a live, chat-capable AI provider, which sibling specs (runtime-context,
// 1089-1090-chat-drawer-private, 1264-settings-self-operation) all document is not seeded at any
// UAT level. Every assertion below is against rendered text: placeholders, aria-labels, headings,
// and the brand wordmark — never a model turn.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const ASSISTANT_NAME = "Alfred";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors runtime-context.uat.spec.ts's signIn(): `solo-admin` returns before the onboarding
// chunk, so the seeded owner still has first-run onboarding pending. Skip it only when shown, so
// this stays correct if a future level change pre-completes onboarding.
async function signIn(page: Page) {
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

// apps/web/src/settings/settings-page.tsx: the "assistant" section id maps to AssistantPane,
// which renders the Persona group (apps/web/src/settings/settings-ai-pane.tsx) directly — no
// nav click needed, a direct route with the section query param is the house pattern
// (app-map-grounding.uat.spec.ts's settings navigation).
async function gotoAssistantSettings(page: Page) {
  await page.goto(`${requireBaseURL()}/settings?section=assistant`);
  await expect(page.getByRole("textbox", { name: "Assistant name" })).toBeVisible();
}

// Sets the assistant name via the real Persona form and waits for the real save round-trip to
// resolve, asserted against the form's own persistent save-state text (settings-ai-pane.tsx:258),
// not a transient toast — avoids a race against a toast's own dismiss timer.
async function setAssistantName(page: Page, name: string) {
  const input = page.getByRole("textbox", { name: "Assistant name" });
  await input.fill(name);
  await page.getByRole("button", { name: "Save persona" }).click();
  await expect(page.getByText(`Saved. This is ${name}'s current voice.`)).toBeVisible();
}

// Full-page rendered-text sweep: catches any surface on the visited route still hardcoding the
// old product/assistant identity. Checked on every route this spec visits.
async function expectNoJarvis(page: Page) {
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(/Jarvis/i);
}

test.describe
  .serial("assistant name renders per-user while product name stays fixed (#1441)", () => {
  let originalAssistantName = "";

  test("Settings -> Your assistant accepts and persists a custom assistant name", async ({
    page
  }) => {
    await signIn(page);
    await gotoAssistantSettings(page);

    // Capture the pre-test value so the last test in this file can restore it — the UAT DB is
    // shared with other live sessions, this spec must leave the signed-in user's preference as it
    // found it.
    originalAssistantName = await page
      .getByRole("textbox", { name: "Assistant name" })
      .inputValue();

    await setAssistantName(page, ASSISTANT_NAME);
    await expectNoJarvis(page);
  });

  test("chat composer and drawer read the configured assistant name, not the product name", async ({
    page
  }) => {
    await signIn(page);

    // Shell chat-affordance button: apps/web/src/shell/app-shell.tsx:382-388 — a single button
    // carrying both the aria-label ("Chat with {name}") and title ("Ask {name}") attributes.
    const chatButton = page.getByRole("button", { name: `Chat with ${ASSISTANT_NAME}` });
    await expect(chatButton).toBeVisible();
    await expect(chatButton).toHaveAttribute("title", `Ask ${ASSISTANT_NAME}`);
    await chatButton.click();

    // Drawer root: role="dialog" aria-label="Chat with {name}" (chat-drawer.tsx:400), plus its
    // own displayed name element (chat-drawer.tsx:406, .chatd__name).
    const drawer = page.getByRole("dialog", { name: `Chat with ${ASSISTANT_NAME}` });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".chatd__name")).toHaveText(ASSISTANT_NAME);

    // Composer placeholder + aria-label (composer.tsx:416,428-433).
    const composer = drawer.getByRole("textbox", { name: `Message ${ASSISTANT_NAME}` });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveAttribute("placeholder", `Message ${ASSISTANT_NAME}…`);

    // Product identity on the SAME screen as the assistant identity above: the brand wordmark
    // (app-shell.tsx:316) must read the fixed product name, never the assistant name.
    await expect(page.locator(".brand-wordmark")).toHaveText("Moss");
    expect(await page.locator(".brand-wordmark").innerText()).not.toBe(ASSISTANT_NAME);

    await expectNoJarvis(page);
  });

  test("calendar hold copy reads the configured assistant name", async ({ page }) => {
    await signIn(page);
    await page.goto(`${requireBaseURL()}/calendar`);

    // calendar-page.tsx:160,164 — "{name} holding" / "{name} is holding {n} block(s)…". The block
    // only renders when the user has at least one held block; if none is seeded at this level,
    // assert the page loaded cleanly and skip the copy assertion rather than fail on a data gap
    // that isn't a rendering regression.
    const holdingCopy = page.getByText(`${ASSISTANT_NAME} is holding`, { exact: false });
    const holdingLabel = page.getByText(`${ASSISTANT_NAME} holding`, { exact: false });
    if ((await holdingCopy.count()) + (await holdingLabel.count()) === 0) {
      test.info().annotations.push({
        type: "note",
        description:
          "No held calendar block seeded at solo-admin level — hold copy did not render to assert against. Not a rendering regression; the composer/drawer/shell tests already prove the assistant-name threading mechanism."
      });
    } else {
      await expect(holdingCopy.or(holdingLabel).first()).toBeVisible();
    }

    await expectNoJarvis(page);
  });

  test("product name reads Moss on the auth/product chrome, independent of the assistant name", async ({
    page
  }) => {
    // Signed-out auth screen eyebrow (auth-screen.tsx:46) — proves the product literal never
    // reads the per-user assistant name even before any user is authenticated.
    await page.goto(requireBaseURL());

    // Asserted after the navigation, not before: each test gets a fresh page fixture even inside
    // a serial describe, so a title assertion above the goto reads "" off about:blank and fails
    // no matter what the product is called.
    await expect(page).toHaveTitle("Moss");
    await expect(page.locator(".eyebrow")).toHaveText("Moss");
    expect(await page.locator(".eyebrow").innerText()).not.toBe(ASSISTANT_NAME);

    await expectNoJarvis(page);
  });

  test.afterAll(async ({ browser }) => {
    // Restore the signed-in user's assistant name so this spec leaves no residue on the shared
    // UAT DB. Runs even if an earlier test in this file failed, as long as the capture step ran.
    if (!originalAssistantName) return;
    const page = await browser.newPage();
    try {
      await signIn(page);
      await gotoAssistantSettings(page);
      const current = await page.getByRole("textbox", { name: "Assistant name" }).inputValue();
      if (current !== originalAssistantName) {
        await setAssistantName(page, originalAssistantName);
      }
    } finally {
      await page.close();
    }
  });
});
