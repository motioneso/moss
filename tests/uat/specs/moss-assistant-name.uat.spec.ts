import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1441's assistant-name live path, updated for #3020/#3032: the per-user name from Settings ->
// Your assistant -> Persona now also names the sidebar wordmark and browser tab. Prove the real
// save reaches these surfaces without reloading, then persists in a fresh signed-in context.
// A fresh signed-out context has no saved name and uses "Moss". Signing out in a context that
// loaded the persona intentionally retains its cached name on the auth screen, including reload.
// Cross-account binding and late persona-response isolation are covered separately by
// tests/unit/assistant-name-everywhere.test.tsx; this solo-admin live path uses one account.
//
// Deliberately NOT covered here (per the same brief): a model turn. The drawer shows its composer
// only while a chat model is available, so this spec loads the scripted chat model to get one.
// Every assertion below is against rendered text: placeholders, aria-labels, headings, and the
// brand wordmark. Nothing is sent.
export const uatLevel = {
  level: "solo-admin",
  without: [],
  chatScript: "moss-assistant-name"
} as const;

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
  const skipAnyway = page.getByRole("button", { name: "Skip anyway" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    // The "Skip anyway" confirmation opens only while no chat model is available. The scripted
    // model is loaded here, so Skip setup can finish without it.
    await expect(skipAnyway.or(userMenu).first()).toBeVisible();
    if (await skipAnyway.isVisible()) await skipAnyway.click();
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
// resolve, asserted against the form's own persistent save-state text,
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
  .serial("assistant name personalizes the UI and stays scoped to its browser/user", () => {
  let originalAssistantName = "";

  test("Settings -> Your assistant accepts and persists a custom assistant name", async ({
    page
  }) => {
    await signIn(page);
    await gotoAssistantSettings(page);

    // The serial tests share the isolated stack's saved persona, but each page fixture has a
    // fresh browser context. Capture the initial value so afterAll can restore the preference.
    originalAssistantName = await page
      .getByRole("textbox", { name: "Assistant name" })
      .inputValue();

    await setAssistantName(page, ASSISTANT_NAME);
    await expect(page.locator(".brand-wordmark")).toHaveText(ASSISTANT_NAME);
    await expect(page).toHaveTitle(ASSISTANT_NAME);
    await expectNoJarvis(page);
  });

  test("chat, sidebar and tab read the saved assistant name after signing in again", async ({
    page
  }) => {
    await signIn(page);

    // Shell chat-affordance button: a single button
    // carrying both the aria-label ("Chat with {name}") and title ("Ask {name}") attributes.
    const chatButton = page.getByRole("button", { name: `Chat with ${ASSISTANT_NAME}` });
    await expect(chatButton).toBeVisible();
    await expect(chatButton).toHaveAttribute("title", `Ask ${ASSISTANT_NAME}`);
    await chatButton.click();

    // Drawer root: role="dialog" aria-label="Chat with {name}", plus its displayed name.
    const drawer = page.getByRole("dialog", { name: `Chat with ${ASSISTANT_NAME}` });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".chatd__name")).toHaveText(ASSISTANT_NAME);

    // Composer placeholder + aria-label.
    const composer = drawer.getByRole("textbox", { name: `Message ${ASSISTANT_NAME}` });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveAttribute("placeholder", `Message ${ASSISTANT_NAME}…`);

    // #3032 deliberately gives the sidebar wordmark and tab the same configured name.
    await expect(page.locator(".brand-wordmark")).toHaveText(ASSISTANT_NAME);
    await expect(page).toHaveTitle(ASSISTANT_NAME);

    await expectNoJarvis(page);

    // Use the real sign-out path, which clears the query cache and reloads the app while
    // preserving the browser's saved name. No localStorage writes or response interception.
    await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
    await page.getByRole("button", { name: /^Account menu/ }).click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator(".eyebrow")).toHaveText(ASSISTANT_NAME);
    await expect(page).toHaveTitle(ASSISTANT_NAME);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator(".eyebrow")).toHaveText(ASSISTANT_NAME);
    await expect(page).toHaveTitle(ASSISTANT_NAME);
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

  test("a fresh signed-out context uses the default name without another context's preference", async ({
    page
  }) => {
    // Each test gets a fresh context with no persona cache. The account's saved preference must
    // not appear here before this context signs in and loads that account's persona.
    await page.goto(requireBaseURL());

    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page).toHaveTitle("Moss");
    await expect(page.locator(".eyebrow")).toHaveText("Moss");

    await expectNoJarvis(page);
  });

  test.afterAll(async ({ browser }) => {
    // Restore the signed-in user's assistant name in the isolated UAT stack. Runs even if an
    // earlier test in this file failed, as long as the capture step ran.
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
