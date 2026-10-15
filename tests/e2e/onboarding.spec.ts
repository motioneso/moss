import { expect, test } from "@playwright/test";

import { defaultOnboardingStatus } from "./mock-onboarding-api.js";
import { createMockConnectorAccount, createMockConnectorProviders, mockApi } from "./mock-api.js";

test("bootstrap owner with incomplete onboarding sees the wizard, then the app shell after finish", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus()
  });

  await page.goto("/");
  await expect(page.getByText("Moss setup")).toBeVisible();
  await expect(page.getByLabel("Onboarding progress").getByText("Owner")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Let’s get your Moss set up." })).toBeVisible();
  await expect(
    page.getByText("Select the AI tool you want to run. We'll check if it's installed.")
  ).toBeVisible();
  await expect(page.getByText("Skip setup and open the app.")).toBeVisible();
  await expect(page.getByText("Tweaks")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Ask Moss/ })).toHaveCount(0);

  await page.getByRole("button", { name: /Start setup/ }).click();
  const continueButton = page.getByRole("button", { name: /Continue/ });
  while (await continueButton.isVisible()) {
    await continueButton.click();
  }
  await expect(page.getByRole("heading", { name: "Review your setup." })).toBeVisible();
  // v0.1.3 founder flow: welcome → Assistant (cliAuth) → Google (connectors) → Finish.
  // The multiplexer "Control channel" step is gone; the finish recap shows Provider + Google.
  await expect(
    page.getByLabel("Onboarding step").getByText("Provider", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByLabel("Onboarding step").getByText("Google", { exact: true })
  ).toBeVisible();
  // b4d70e21 ("remove unreliable finish choices") collapsed the three finish buttons into one that
  // always lands on /today, so the old "Open today’s brief" label is gone.
  await page.getByRole("button", { name: "Finish setup" }).click();

  // After finish the status mock returns state:"completed"; the app.tsx branch falls through.
  await expect(
    page.getByRole("heading", { name: "Let’s get your Moss set up." })
  ).not.toBeVisible();
});

// REMOVED: "onboarding finish settings destination reaches Settings". b4d70e21 ("remove unreliable
// finish choices") deleted the finish step's per-destination buttons — it is now a single "Finish
// setup" that always lands on /today, because the old choice navigated via
// window.location.replace and was flaky. Ben approved dropping the Settings exit on 2026-07-27;
// users reach Settings from the shell afterwards. The remaining finish coverage is the test above.

test("Skip setup on the first step reaches the app shell", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus()
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Let’s get your Moss set up." })).toBeVisible();
  await page.getByRole("button", { name: "Skip setup" }).first().click();
  await page
    .getByRole("dialog", { name: "Skip setup without connecting a provider?" })
    .getByRole("button", { name: "Skip anyway" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Let’s get your Moss set up." })
  ).not.toBeVisible();
  await expect(page.locator(".module-nav").getByRole("link", { name: "Today" })).toBeVisible();
});

test("a connected provider renders the ready state on the cliAuth step", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({
      // v0.1.3: onboarding offers only `anthropic`; the multiplexer step is gone.
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    })
  });

  await page.goto("/");
  await page
    .getByLabel("Onboarding progress")
    .getByRole("button", { name: /Assistant/ })
    .click();
  await expect(page.getByRole("heading", { name: "Connect your AI provider." })).toBeVisible();
  await expect(page.getByText("1 provider connected · chat is ready")).toBeVisible();
  await expect(page.locator(".onb-detect", { hasText: "Connected" })).toBeVisible();
});

test("a non-owner never sees the wizard", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: false, // non-admin ⇒ non-owner (meResponseFor keeps it coherent)
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus() // even incomplete, must be ignored for non-owners
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Let’s get your Moss set up." })
  ).not.toBeVisible();
});

test("a status-endpoint error falls through to the app shell", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  // Override status to 500 AFTER mockApi registers its 200 handler (last route wins).
  await page.route("**/api/onboarding/status", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "down" })
    })
  );

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Let’s get your Moss set up." })
  ).not.toBeVisible();
});

test("onboarding offers IMAP providers and makes no Microsoft promises", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    })
  });

  await page.goto("/");
  await page
    .getByLabel("Onboarding progress")
    .getByRole("button", { name: /Google/ })
    .click();

  for (const provider of ["Yahoo Mail", "Proton Mail", "iCloud", "Fastmail"]) {
    await expect(
      page.getByRole("button", { name: new RegExp(`Connect ${provider}`, "i") })
    ).toBeVisible();
  }

  await expect(page.getByText("Outlook")).toHaveCount(0);
  await expect(page.getByText("Microsoft 365")).toHaveCount(0);

  await page.getByRole("button", { name: /Connect Proton Mail/i }).click();
  await expect(
    page.getByText(/Requires a paid Proton plan with Proton Mail Bridge installed and running/i)
  ).toBeVisible();
  await expect(
    page.getByText(/Passwords are encrypted at rest and never shown in logs or briefings/i)
  ).toBeVisible();
  await expect(page.locator(".onb-guide__step")).toHaveCount(3);
  await expect(page.getByRole("link", { name: /Proton Mail setup guide/i })).toHaveAttribute(
    "href",
    "https://proton.me/support/protonmail-bridge-install"
  );

  const remainingHelpLinks: Record<string, string> = {
    "Yahoo Mail": "https://help.yahoo.com/kb/SLN15241.html",
    iCloud: "https://support.apple.com/en-us/102654",
    Fastmail: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords"
  };

  for (const [name, url] of Object.entries(remainingHelpLinks)) {
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: new RegExp(`Connect ${name}`, "i") }).click();
    await expect(page.locator(".onb-guide__step")).not.toHaveCount(0);
    await expect(
      page.getByRole("link", { name: new RegExp(`${name} setup guide`, "i") })
    ).toHaveAttribute("href", url);
  }
});

test("Google and IMAP provider cards share equal visual weight and a stable order", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    })
  });

  await page.goto("/");
  await page
    .getByLabel("Onboarding progress")
    .getByRole("button", { name: /Google/ })
    .click();

  // Every provider CTA (Google + 4 IMAP) renders through the same full-weight card — no
  // dashed "More services" secondary treatment left for any of the five.
  const cards = page.locator(".onb-prov");
  await expect(cards).toHaveCount(5);
  await expect(page.locator(".onb-provmini")).toHaveCount(0);
  await expect(cards.nth(0)).toContainText("Connect Google");
  await expect(cards.nth(1)).toContainText("Connect Yahoo Mail");
  await expect(cards.nth(2)).toContainText("Connect Proton Mail");
  await expect(cards.nth(3)).toContainText("Connect iCloud");
  await expect(cards.nth(4)).toContainText("Connect Fastmail");
});

test("Connect another account shows the picker, cancel returns to the connected summary", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [
      createMockConnectorAccount("google-account-1", {
        providerId: "google",
        providerType: "google",
        providerDisplayName: "Google",
        status: "active"
      })
    ],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: true }
      }
    })
  });

  await page.goto("/");
  await page
    .getByLabel("Onboarding progress")
    .getByRole("button", { name: /Google/ })
    .click();

  await expect(page.getByRole("heading", { name: "Google connected" })).toBeVisible();
  await expect(page.getByText("Connected accounts")).toBeVisible();

  await page.getByRole("button", { name: "Connect another account" }).click();

  await expect(page.getByText("Choose a service to connect")).toBeVisible();
  await expect(page.getByText("Connected accounts")).not.toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("heading", { name: "Google connected" })).toBeVisible();
  await expect(page.getByText("Connected accounts")).toBeVisible();
});

test("one-click Google consent opens the popup on the first click", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    })
  });

  await page.goto("/");
  await page
    .getByLabel("Onboarding progress")
    .getByRole("button", { name: /Google/ })
    .click();
  await page.getByRole("button", { name: /Connect Google/i }).click();

  await page
    .getByLabel("Client ID", { exact: true })
    .fill("000000-xxxx.apps.googleusercontent.com");
  await page.getByLabel("Client secret", { exact: true }).fill("GOCSPX-secret");

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open consent screen" }).click()
  ]);
  await popup.waitForURL(/accounts\.google\.com/);
  expect(popup.url()).toContain("accounts.google.com");
});

test("blocked popup shows a manual link and explanation", async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    })
  });

  await page.goto("/");
  await page
    .getByLabel("Onboarding progress")
    .getByRole("button", { name: /Google/ })
    .click();
  await page.getByRole("button", { name: /Connect Google/i }).click();

  await page
    .getByLabel("Client ID", { exact: true })
    .fill("000000-xxxx.apps.googleusercontent.com");
  await page.getByLabel("Client secret", { exact: true }).fill("GOCSPX-secret");
  await page.getByRole("button", { name: "Open consent screen" }).click();

  await expect(page.getByText(/browser blocked the popup/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open manually/i })).toBeVisible();
});

test("failed authorization closes the popup and surfaces the error", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    })
  });
  await page.route("**/api/connectors/google/authorize", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Authorization failed." })
    })
  );

  await page.goto("/");
  await page
    .getByLabel("Onboarding progress")
    .getByRole("button", { name: /Google/ })
    .click();
  await page.getByRole("button", { name: /Connect Google/i }).click();

  await page
    .getByLabel("Client ID", { exact: true })
    .fill("000000-xxxx.apps.googleusercontent.com");
  await page.getByLabel("Client secret", { exact: true }).fill("GOCSPX-secret");

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Open consent screen" }).click()
  ]);
  // The mock 500 resolves fast enough that the popup can already be closed by the time we
  // start waiting — don't block on an event that may have already fired.
  if (!popup.isClosed()) {
    await popup.waitForEvent("close");
  }

  await expect(page.getByText("Authorization failed.")).toBeVisible();
});
