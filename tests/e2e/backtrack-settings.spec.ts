import { expect, test, type Page } from "@playwright/test";
import type { BacktrackStatusResponse, MeSessionDto } from "@moss/shared";

import { mockApi } from "./mock-api.js";

// Moss Settings -> Backtrack (#2638 plan §4.8): the screen states, and what the browser sends.
// Time-zone work uses a fixed zone and a fixed clock, so the expected range is exact.

test.use({ timezoneId: "America/Los_Angeles" });

const URL_PATH = "/settings?section=modules&module=backtrack";

function mac(): MeSessionDto {
  return {
    id: "session-mac",
    isCurrent: false,
    createdAt: "2026-10-01T12:00:00.000Z",
    lastSeenAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-11-01T12:00:00.000Z",
    ipAddress: null,
    userAgent: null,
    deviceLabel: "Ben's MacBook",
    browser: null,
    os: null,
    deviceKind: "laptop",
    source: "companion",
    companion: {
      product: "trail-marker",
      displayName: "Ben's MacBook",
      appVersion: "1.0",
      osVersion: "26.0",
      lastContactAt: "2026-10-04T12:00:00.000Z"
    }
  };
}

const ON: BacktrackStatusResponse = {
  storage: "on",
  paused: false,
  macs: 1,
  days: 12,
  bytes: 2_500_000,
  oldest: "2026-09-22T12:00:00.000Z",
  lastReceivedAt: "2026-10-04T12:00:00.000Z"
};

interface Sent {
  deletes: Array<Record<string, unknown>>;
  puts: Array<Record<string, unknown>>;
  statusFailing: boolean;
}

async function setup(
  page: Page,
  options: { status?: BacktrackStatusResponse; macs?: number; statusFails?: boolean }
): Promise<Sent> {
  const sent: Sent = {
    deletes: [],
    puts: [],
    statusFailing: options.statusFails === true
  };
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  const sessions = Array.from({ length: options.macs ?? 0 }, mac);
  await page.route("**/api/me/sessions", (route) => route.fulfill({ json: { sessions } }));
  await page.route("**/api/backtrack/status", (route) => {
    if (sent.statusFailing) return route.fulfill({ status: 500, json: { error: "boom" } });
    return route.fulfill({ json: options.status ?? ON });
  });
  await page.route("**/api/backtrack/preferences", (route) => {
    sent.puts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { paused: true } });
  });
  await page.route("**/api/backtrack/segments", (route) => {
    sent.deletes.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    return route.fulfill({ json: { deleted: 3 } });
  });
  return sent;
}

test("a linked Mac with history shows the switch, what is kept, and the delete row", async ({
  page
}) => {
  await setup(page, { macs: 1 });
  await page.goto(URL_PATH);

  await expect(page.getByText("On · 1 Mac")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Recording" })).toBeChecked();
  await expect(page.getByText("12 days")).toBeVisible();
  await expect(page.getByText("2.4 MB")).toBeVisible();
  await expect(page.getByText("37 days, plus up to one hourly run")).toBeVisible();
  for (const name of ["Last hour", "Today", "Choose a day…", "Everything…"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  // Decision 8: nothing about notes before Phase 4.
  await expect(page.getByText(/notes folder|daily notes/i)).toHaveCount(0);
});

test("turning Recording off pauses every Mac", async ({ page }) => {
  const sent = await setup(page, { macs: 1 });
  await page.goto(URL_PATH);
  await page.locator(".jds-switch").click();
  await expect.poll(() => sent.puts).toEqual([{ paused: true }]);
});

test("Today asks first, then sends the browser-local day as a range", async ({ page }) => {
  const sent = await setup(page, { macs: 1 });
  await page.clock.setFixedTime(new Date("2026-10-04T20:00:00.000Z"));
  await page.goto(URL_PATH);
  await page.getByRole("button", { name: "Today" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete today?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent.deletes).toEqual([]);
  await page.getByRole("button", { name: "Today" }).click();
  await page
    .getByRole("dialog", { name: "Delete today?" })
    .getByRole("button", { name: "Delete today" })
    .click();
  // 13:00 on 4 October in Los Angeles (PDT): midnight to midnight is 07:00Z to 07:00Z.
  await expect
    .poll(() => sent.deletes)
    .toEqual([{ from: "2026-10-04T07:00:00.000Z", to: "2026-10-05T07:00:00.000Z" }]);
  await expect(page.getByText("Deleted 3 stored segments.")).toBeVisible();
});

test("Last hour asks first, then sends the hour before the confirmation", async ({ page }) => {
  const sent = await setup(page, { macs: 1 });
  await page.clock.setFixedTime(new Date("2026-10-04T20:00:00.000Z"));
  await page.goto(URL_PATH);
  await page.getByRole("button", { name: "Last hour" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete the last hour?" });
  await expect(dialog).toBeVisible();
  expect(sent.deletes).toEqual([]);
  await dialog.getByRole("button", { name: "Delete the last hour" }).click();
  await expect
    .poll(() => sent.deletes)
    .toEqual([{ from: "2026-10-04T19:00:00.000Z", to: "2026-10-04T20:00:00.000Z" }]);
});

test("Everything asks first, then sends no range", async ({ page }) => {
  const sent = await setup(page, { macs: 1 });
  await page.goto(URL_PATH);
  await page.getByRole("button", { name: "Everything…" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete all of Backtrack?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent.deletes).toEqual([]);

  await page.getByRole("button", { name: "Everything…" }).click();
  await page
    .getByRole("dialog", { name: "Delete all of Backtrack?" })
    .getByRole("button", { name: "Delete everything" })
    .click();
  await expect.poll(() => sent.deletes).toEqual([{}]);
});

test("no Mac linked but history stored still offers delete", async ({ page }) => {
  await setup(page, { macs: 0, status: { ...ON, macs: 0 } });
  await page.goto(URL_PATH);
  await expect(page.getByText(/No Mac is linked/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Everything…" })).toBeVisible();
});

test("no Mac and no history is an empty state", async ({ page }) => {
  await setup(page, {
    macs: 0,
    status: { storage: "on", paused: false, macs: 0, days: 0, bytes: 0 }
  });
  await page.goto(URL_PATH);
  await expect(page.getByText("No Mac is linked")).toBeVisible();
  await expect(page.getByRole("button", { name: "Everything…" })).toHaveCount(0);
});

test("storage off says so, and offers delete only when rows exist", async ({ page }) => {
  await setup(page, { macs: 0, status: { ...ON, storage: "off", macs: 0 } });
  await page.goto(URL_PATH);
  await expect(page.getByText(/storage isn't available on this Moss yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Everything…" })).toBeVisible();
});

test("storage off with no rows has no delete row", async ({ page }) => {
  await setup(page, {
    macs: 0,
    status: { storage: "off", paused: false, macs: 0, days: 0, bytes: 0 }
  });
  await page.goto(URL_PATH);
  await expect(page.getByText(/storage isn't available on this Moss yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Everything…" })).toHaveCount(0);
});

test("a failed load shows an error with retry", async ({ page }) => {
  const sent = await setup(page, { macs: 1, statusFails: true });
  await page.goto(URL_PATH);
  await expect(page.getByText("Could not load Backtrack.")).toBeVisible();
  sent.statusFailing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("On · 1 Mac")).toBeVisible();
});
