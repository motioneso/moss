import { expect, test } from "@playwright/test";

import { createMockConnectorAccount, createMockConnectorProviders, mockApi } from "./mock-api.js";

test("service picker offers Google and Email (IMAP) — no GitHub, Apple, or Other (OAuth)", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Connected accounts" }).click();

  await expect(page.getByRole("button", { name: "Google", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email (IMAP)" })).toBeVisible();
  await expect(page.getByRole("button", { name: /GitHub/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apple" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Other (OAuth)" })).toHaveCount(0);
});

test("connects an email account via the settings IMAP flow", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Connected accounts" }).click();
  await page.getByRole("button", { name: "Email (IMAP)" }).click();

  await page.getByRole("button", { name: /Fastmail/ }).click();
  await expect(page.locator(".gflow__title", { hasText: "Connect Fastmail" })).toBeVisible();

  await page.getByLabel("Email address").fill("me@fastmail.com");
  await page.getByLabel("App password").fill("app-password-123");

  const connect = page.getByRole("button", { name: "Connect Fastmail" });
  await expect(connect).toBeEnabled();
  await connect.click();

  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
  await expect(page.getByText("Connect Fastmail")).not.toBeVisible();
});

test("reconnect on an IMAP account opens ImapConnect, not GoogleConnect", async ({ page }) => {
  const imapAccount = createMockConnectorAccount("imap-account-2", {
    providerId: "imap-icloud",
    providerType: "imap",
    providerDisplayName: "iCloud",
    status: "error",
    lastSyncStatus: "failed",
    lastSyncError: "auth-error"
  });

  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [imapAccount],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Connected accounts" }).click();
  await page.getByRole("button", { name: "Reconnect" }).click();

  await expect(page.getByText("Choose an email provider")).toBeVisible();
  await expect(page.getByText("Connect Google")).not.toBeVisible();
});
