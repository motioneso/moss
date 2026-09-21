import { expect, test } from "@playwright/test";

import { createMockConnectorProviders, mockApi, type MockApiState } from "./mock-api.js";

// The page a Mac sends someone to when it wants to link (#2560). It runs against the mock API
// with a pending request, and checks what the person is shown before they agree and what the
// browser sends when they do.

test("approving a waiting Mac lists what it may do, then links it", async ({ page }) => {
  const state: MockApiState = {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    companionPairAttempt: { deviceName: "Ben's MacBook", status: "pending" }
  };
  await mockApi(page, state);

  await page.goto("/link/trail-marker#code=abc123");

  await expect(page.getByRole("heading", { name: "Do you recognise this Mac?" })).toBeVisible();
  await expect(page.getByText("Ben's MacBook")).toBeVisible();
  await expect(page.getByText("A linked Mac will be able to:")).toBeVisible();
  await expect(page.getByText("read which focus block you have on right now")).toBeVisible();
  await expect(
    page.getByText("report which app is in front while a focus block is on")
  ).toBeVisible();
  await expect(page.getByText("cannot read your data")).toHaveCount(0);

  await page.getByRole("button", { name: /approve/i }).click();

  await expect(page.getByRole("heading", { name: "That Mac is connected" })).toBeVisible();
  expect(state.companionPairAttempt?.lastDecision).toEqual({ code: "abc123", decision: "approve" });
});

test("declining a waiting Mac links nothing", async ({ page }) => {
  const state: MockApiState = {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    companionPairAttempt: { deviceName: "Ben's MacBook", status: "pending" }
  };
  await mockApi(page, state);

  await page.goto("/link/trail-marker#code=abc123");
  await page.getByRole("button", { name: /decline|deny/i }).click();

  await expect(page.getByRole("heading", { name: "Nothing was connected" })).toBeVisible();
  expect(state.companionPairAttempt?.lastDecision?.decision).toBe("deny");
});
