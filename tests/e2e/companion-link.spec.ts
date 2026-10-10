import { join } from "node:path";
import { expect, test, type TestInfo } from "@playwright/test";

import { createMockConnectorProviders, mockApi, type MockApiState } from "./mock-api.js";

function visualPath(testInfo: TestInfo, filename: string): string {
  const directory = process.env.MOSS_VISUAL_ARTIFACT_DIR;
  return directory ? join(directory, filename) : testInfo.outputPath(filename);
}

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

test("a long Mac name stays within the phone viewport before and after approval", async ({
  page
}) => {
  const deviceName = `Example-${"LongDeviceName".repeat(4)}`;
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const state: MockApiState = {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: [],
      companionPairAttempt: { deviceName, status: "pending" }
    };
    await mockApi(page, state);
    await page.goto(`/link/trail-marker#code=long-name-${width}`);
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
    await expect(page.getByText(deviceName, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "is linked" })).toContainText(
      deviceName
    );
    expect(state.companionPairAttempt?.lastDecision).toEqual({
      code: `long-name-${width}`,
      decision: "approve"
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
  }
});

// These use the real page with synthetic responses. They establish UI behavior only;
// native linking, device permissions and live recording still require separate Mac proof.
test("request checking and failed transport are announced with a read-only retry", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/companion/pair/attempt", async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { error: "Synthetic unavailable response" } });
  });
  await page.goto("/link/trail-marker#code=example-request");
  await expect(page.getByRole("status").filter({ hasText: "Checking the request" })).toBeVisible();
  release();
  await expect(page.getByRole("alert")).toContainText("Couldn't check this request.");
  await expect(page.getByText("That request is no longer open")).toHaveCount(0);
  await page.screenshot({
    path: visualPath(testInfo, "link-request-transport-failure-320.png"),
    fullPage: true
  });
  let decisions = 0;
  await page.route("**/api/companion/pair/decide", async (route) => {
    decisions += 1;
    await route.fulfill({ json: { status: "approved" } });
  });
  await page.route("**/api/companion/pair/attempt", (route) =>
    route.fulfill({
      json: {
        deviceName: `Example-${"LongDeviceName".repeat(4)}`,
        status: "pending",
        recordingPolicyVersion: 1
      }
    })
  );
  await page.getByRole("button", { name: "Check request again" }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect(page.getByText("Record meetings when you choose Start")).toBeVisible();
  expect(decisions).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(1);
});

test("a closed request is distinct from a transport problem", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  await page.route("**/api/companion/pair/attempt", (route) =>
    route.fulfill({
      status: 404,
      json: { error: "That link request is no longer open" }
    })
  );
  await page.goto("/link/trail-marker#code=closed-request");
  await expect(page.getByRole("alert")).toContainText("Start a new one from the Mac");
  await expect(page.getByRole("button", { name: "Check request again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("an uncertain answer requires a status check before another decision", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: [],
    companionPairAttempt: { deviceName: "Example Mac", status: "pending" }
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/companion/pair/decide", async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { error: "Synthetic uncertain response" } });
  });
  await page.goto("/link/trail-marker#code=example-request");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approving this Mac" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline", exact: true })).toBeDisabled();
  await page.screenshot({
    path: visualPath(testInfo, "link-request-approving-390.png"),
    fullPage: true
  });
  release();
  await expect(page.getByRole("alert")).toContainText("Couldn't confirm your answer");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  let releaseRecheck!: () => void;
  const rechecking = new Promise<void>((resolve) => {
    releaseRecheck = resolve;
  });
  await page.route("**/api/companion/pair/attempt", async (route) => {
    await rechecking;
    await route.fulfill({ json: { deviceName: "Example Mac", status: "approved" } });
  });
  await page.getByRole("button", { name: "Check request again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Checking the request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  releaseRecheck();
  await expect(page.getByRole("status").filter({ hasText: "was already answered" })).toContainText(
    "Example Mac"
  );
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("a new request in the same tab does not inherit the previous decision", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: [],
    companionPairAttempt: { deviceName: "First example Mac", status: "pending" }
  });
  await page.goto("/link/trail-marker#code=first-example-request");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Request declined" })).toBeVisible();
  await page.route("**/api/companion/pair/attempt", (route) =>
    route.fulfill({
      json: { deviceName: "Second example Mac", status: "pending" }
    })
  );
  await page.evaluate(() => {
    window.location.hash = "code=second-example-request";
  });
  await expect(page.getByRole("heading", { name: "Do you recognise this Mac?" })).toBeVisible();
  await expect(page.getByText("Second example Mac")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect(page.getByText("Request declined.")).toHaveCount(0);
});
