import { expect, test, type Page } from "@playwright/test";

import { mockApi } from "./mock-api.js";

type KeySource = "env" | "store" | "missing";

async function mockEncryptionKeys(page: Page, initial: KeySource): Promise<void> {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  let source: KeySource = initial;
  await page.route("**/api/admin/settings/encryption-keys", (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      source = "store";
      return route.fulfill({ json: { keys: [{ family: "integrations", source }] } });
    }
    return route.fulfill({ json: { keys: [{ family: "integrations", source }] } });
  });
  await page.route("**/api/admin/settings/encryption-keys/rotate", (route) =>
    route.fulfill({ json: { keys: [{ family: "integrations", source }] } })
  );
}

test("admin generates a missing key from the banner and rotates it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockEncryptionKeys(page, "missing");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Admin / Setup" }).click();

  await expect(page.getByText("Encryption needs attention")).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page).toHaveURL(/\?section=enckeys$/);
  await expect(page.getByRole("heading", { name: "Encryption keys" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText("Ready (stored).")).toBeVisible();
  await expect(page.getByText("Encryption needs attention")).toHaveCount(0);

  await page.getByRole("button", { name: "Rotate" }).click();
  await expect(page.getByText("Encryption key rotated")).toBeVisible();
  await expect(page.getByText("Ready (stored).")).toBeVisible();
});

test("a broken key tells the truth and replaces with confirmation", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  let source = "broken";
  await page.route("**/api/admin/settings/encryption-keys", (route) =>
    route.fulfill({ json: { keys: [{ family: "integrations", source }] } })
  );
  await page.route("**/api/admin/settings/encryption-keys/rotate", (route) => {
    source = "store";
    return route.fulfill({ json: { keys: [{ family: "integrations", source }] } });
  });
  await page.goto("/settings?section=enckeys");
  await expect(page.getByText("Stopped: the stored key no longer opens")).toBeVisible();
  await expect(page.getByRole("button", { name: "Rotate" })).toHaveCount(0);

  let dialogShown = false;
  page.on("dialog", (dialog) => {
    dialogShown = true;
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Replace key" }).click();
  await expect(page.getByText("Ready (stored).")).toBeVisible();
  expect(dialogShown).toBe(true);
});

test("a settings-file cause offers no button, only the fix-it-there sentence", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  await page.route("**/api/admin/settings/encryption-keys", (route) =>
    route.fulfill({
      json: {
        keys: [{ family: "integrations", source: "broken", cause: "env" }]
      }
    })
  );
  await page.goto("/settings?section=enckeys");
  await expect(
    page.getByText(
      "Stopped: the value in the settings file cannot be used. Fix or remove it there."
    )
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Replace key" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rotate" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Generate", exact: true })
  ).toHaveCount(0);
});

test("admin generates each of the three family keys from the screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  const sources: Record<string, KeySource> = {
    integrations: "missing",
    module_credential: "missing",
    news_credential: "missing"
  };
  const payload = () => ({
    json: {
      keys: Object.entries(sources).map(([family, source]) => ({ family, source }))
    }
  });
  await page.route("**/api/admin/settings/encryption-keys", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { family?: string };
      if (body.family && body.family in sources) sources[body.family] = "store";
    }
    return route.fulfill(payload());
  });
  await page.route("**/api/admin/settings/encryption-keys/rotate", (route) =>
    route.fulfill(payload())
  );
  await page.goto("/settings?section=enckeys");

  await expect(page.getByText("Module credentials")).toBeVisible();
  await expect(page.getByText("News publisher keys")).toBeVisible();
  const generateButtons = page.getByRole("button", { name: "Generate", exact: true });
  await expect(generateButtons).toHaveCount(3);
  // Buttons leave the screen as each family is generated: click the first one
  // still showing, then wait for it to clear before the next click, or two
  // rapid clicks land on the same row before it re-renders.
  for (let remaining = 3; remaining > 0; remaining--) {
    await generateButtons.first().click();
    await expect(generateButtons).toHaveCount(remaining - 1);
  }
  await expect(page.getByText("Ready (stored).")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toHaveCount(0);
});

test("non-admin sees no keys surface and makes no key requests", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: false,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  const keyRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/admin/settings/encryption-keys")) {
      keyRequests.push(request.url());
    }
  });
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Admin / Setup" })).toHaveCount(0);
  expect(keyRequests).toEqual([]);
});
