import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

import { UAT_ADMIN_ID } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

// Chrome forbids push subscriptions in the default incognito test context.
const test = base.extend({
  context: async ({ playwright, baseURL }, use) => {
    const profile = await mkdtemp(join(tmpdir(), "sched-3145-chrome-"));
    const context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chrome",
      headless: false,
      baseURL,
      serviceWorkers: "allow",
      permissions: ["notifications"],
      ignoreDefaultArgs: ["--disable-background-networking"]
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
});

function reminderRows() {
  return JSON.parse(
    execUatSql(
      requireUatProjectName(),
      `
    SELECT COALESCE(json_agg(json_build_object(
      'id', r.id, 'text', r.reminder_text, 'state', r.state, 'messageId', r.reserved_message_id,
      'notificationId', n.id, 'deferredUntil', n.deferred_until, 'body', m.body
    )), '[]'::json)
    FROM app.chat_reminders r
    LEFT JOIN app.chat_messages m ON m.id = r.reserved_message_id
    LEFT JOIN app.notifications n ON n.module_id = 'chat' AND n.event_key = r.reserved_message_id::text
    WHERE r.owner_user_id = '${UAT_ADMIN_ID}'
  `
    ).trim()
  ) as readonly {
    id: string;
    text: string;
    state: string;
    messageId: string;
    notificationId: string | null;
    deferredUntil: string | null;
    body: string | null;
  }[];
}

async function browserNotifications(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return ((await registration?.getNotifications()) ?? []).map((notification) => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag
    }));
  });
}

async function sendInMain(page: Page, text: string) {
  await page.goto("/today");
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  if (!(await composer.isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await composer.fill(text);
  await composer.press("Enter");
  expect((await response).ok()).toBe(true);
  await expect(composer).toHaveValue("");
}

async function setQuiet(page: Page, enabled: boolean, start = "22:00", end = "07:00") {
  await page.goto("/settings?section=alerts");
  const from = page.getByLabel("Quiet hours from");
  await expect(from).toBeEnabled({ timeout: 30_000 });
  await from.fill(start);
  await page.getByLabel("Quiet hours until").fill(end);
  const toggle = page.getByLabel("Enable quiet hours");
  if ((await toggle.isChecked()) !== enabled) {
    await page.locator("label.jds-switch").filter({ has: toggle }).click();
  }
  const save = page.getByRole("button", { name: "Save quiet hours" });
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText("Quiet hours saved.")).toBeVisible();
  }
}

test("an owner allowance skips only quiet hours, and removal and device mute take effect", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  await sendInMain(page, "Reply briefly: ready for the quiet hours proof.");
  await expect(page.getByRole("textbox", { name: "Message Moss" })).toBeEnabled({
    timeout: 120_000
  });
  const locale = (await (await page.request.get("/api/me/locale")).json()) as {
    locale: { timezone: string };
  };
  const hhmm = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: locale.locale.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date);
  const now = new Date();
  await setQuiet(
    page,
    true,
    hhmm(new Date(now.getTime() - 300_000)),
    hhmm(new Date(now.getTime() + 900_000))
  );
  await page.goto("/settings?section=modules&module=notifications");
  await page.getByRole("button", { name: "Enable on this device" }).click();
  await expect(page.getByText("Registered for push notifications.").first()).toBeVisible({
    timeout: 45_000
  });
  await expect(page.getByLabel("Notify from Chat")).toBeChecked();

  const create = async (title: string, seconds = 45) => {
    await sendInMain(page, `remind me in ${seconds} seconds to ${title}`);
    await expect.poll(() => reminderRows().find((row) => row.text === title)?.id).toBeTruthy();
    return reminderRows().find((row) => row.text === title)!;
  };
  const choices = async () => {
    const response = await page.request.get("/api/chat/quiet-hours-allowances");
    expect(response.ok()).toBe(true);
    return (await response.json()) as {
      mainThreadId: string;
      allowances: { id: string; title: string }[];
    };
  };
  const notified = async (id: string) => {
    await expect
      .poll(() => reminderRows().find((row) => row.id === id)?.notificationId, { timeout: 90_000 })
      .toBeTruthy();
    return reminderRows().find((row) => row.id === id)!;
  };
  const allowed = await create("check the allowed quiet kettle", 90);
  await sendInMain(page, "let check the allowed quiet kettle through quiet hours");
  await expect
    .poll(async () => (await choices()).allowances.map((row) => row.id))
    .toContain(allowed.id);
  await page.goto("/settings?section=alerts");
  await expect(page.getByText(allowed.text, { exact: true })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [mode, theme] of [
      ["light", "forest"],
      ["dark", "forest"],
      ["light", "teal"]
    ]) {
      await page.evaluate(
        ({ mode, theme }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.dataset.theme = theme;
        },
        { mode, theme }
      );
      const group = page
        .locator("section.pane__card")
        .filter({ hasText: "Allowed during quiet hours" });
      await expect(page.getByRole("button", { name: "Change in chat" })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      if (await group.count())
        await group.screenshot({
          path: test.info().outputPath(`allowances-${width}-${mode}-${theme}.png`)
        });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const beforeChange = execUatSql(
    requireUatProjectName(),
    `SELECT count(*) FROM app.chat_messages WHERE owner_user_id='${UAT_ADMIN_ID}'`
  ).trim();
  await page.getByRole("button", { name: "Change in chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message Moss" })).toBeVisible();
  expect(
    execUatSql(
      requireUatProjectName(),
      `SELECT count(*) FROM app.chat_messages WHERE owner_user_id='${UAT_ADMIN_ID}'`
    ).trim()
  ).toBe(beforeChange);
  console.log(
    "[3145] Settings lists the saved choice on desktop and phone in light, dark and Teal; Change in chat sends nothing"
  );

  const ordinary = await create("check the ordinary quiet timer");
  const visible = await notified(allowed.id);
  expect(visible.deferredUntil).toBeNull();
  await expect
    .poll(
      async () =>
        (await browserNotifications(page)).filter((row) => row.tag === visible.notificationId),
      { timeout: 90_000 }
    )
    .toHaveLength(1);
  const held = await notified(ordinary.id);
  expect(held.deferredUntil).not.toBeNull();
  expect((await browserNotifications(page)).some((row) => row.tag === held.notificationId)).toBe(
    false
  );
  const urgency = execUatSql(
    requireUatProjectName(),
    `SELECT urgency FROM app.notifications WHERE id = '${visible.notificationId}'`
  ).trim();
  expect(urgency).toBe("normal");
  console.log(
    "[3145] allowed reminder displayed once during quiet hours; ordinary reminder deferred; urgency stayed normal"
  );

  const removed = await create("check the removed quiet allowance");
  await sendInMain(page, "check the removed quiet allowance can buzz me at night");
  await expect
    .poll(async () => (await choices()).allowances.map((row) => row.id))
    .toContain(removed.id);
  await sendInMain(page, `stop letting ${removed.id} through`);
  await expect
    .poll(async () => (await choices()).allowances.map((row) => row.id))
    .not.toContain(removed.id);
  const removedResult = await notified(removed.id);
  expect(removedResult.deferredUntil).not.toBeNull();
  expect(
    (await browserNotifications(page)).some((row) => row.tag === removedResult.notificationId)
  ).toBe(false);
  console.log("[3145] removing the allowance restored quiet-hours deferral");

  await page.goto("/settings?section=modules&module=notifications");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Registered for push notifications.")).toHaveCount(0);
  const muted = await create("check the muted device quiet kettle");
  await sendInMain(page, "let check the muted device quiet kettle through quiet hours");
  await expect
    .poll(async () => (await choices()).allowances.map((row) => row.id))
    .toContain(muted.id);
  const mutedResult = await notified(muted.id);
  expect(mutedResult.deferredUntil).toBeNull();
  await expect
    .poll(() =>
      execUatSql(
        requireUatProjectName(),
        `SELECT state FROM pgboss.job WHERE name='notifications.push.deliver' AND data->>'notificationId'='${mutedResult.notificationId}'`
      ).trim()
    )
    .toBe("completed");
  expect(
    (await browserNotifications(page)).some((row) => row.tag === mutedResult.notificationId)
  ).toBe(false);
  for (const row of [allowed, ordinary, removed, muted]) {
    expect(
      execUatSql(
        requireUatProjectName(),
        `SELECT count(*) FROM app.chat_messages WHERE id='${row.messageId}'`
      ).trim()
    ).toBe("1");
  }
  await expect.poll(async () => (await choices()).allowances).toEqual([]);
  await page.goto("/settings?section=alerts");
  await expect(page.getByText("No tasks are allowed during quiet hours.")).toBeVisible();
  console.log(
    "[3145] disabled device received no alert despite allowance; each reminder kept exactly one chat result; Settings reflects removal"
  );
});
