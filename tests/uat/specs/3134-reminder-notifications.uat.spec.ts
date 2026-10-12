import { expect, test, type Page } from "@playwright/test";

import { UAT_ADMIN_ID } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

// Chrome's real push subscription and the app's existing service worker display the alerts.
test.use({ channel: "chrome", serviceWorkers: "allow", permissions: ["notifications"] });

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
  await composer.fill(text);
  await composer.press("Enter");
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

test("due reminders alert this browser once, wait for quiet hours, and respect the Chat mute", async ({
  page
}) => {
  test.skip(
    !process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED,
    "This proof requires a real signed-in model."
  );
  test.setTimeout(600_000);
  await signInUatAdmin(page);
  await bringUpRealChatModel(page);
  await setQuiet(page, false);
  await page.goto("/settings?section=modules&module=notifications");
  await expect
    .poll(async () =>
      page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active))
    )
    .toBe(true);
  await page.getByRole("button", { name: "Enable on this device" }).click();
  await expect(page.getByText("Registered for push notifications.").first()).toBeVisible({
    timeout: 45_000
  });
  await expect(page.getByLabel("Notify from Chat")).toBeChecked();

  await sendInMain(page, "remind me in 10 seconds to check the proof kettle");
  await expect
    .poll(() => reminderRows().find((row) => row.text === "check the proof kettle")?.state, {
      timeout: 45_000
    })
    .toBe("delivered");
  const first = reminderRows().find((row) => row.text === "check the proof kettle")!;
  await expect
    .poll(() => reminderRows().find((row) => row.id === first.id)?.notificationId)
    .not.toBeNull();
  const notificationId = reminderRows().find((row) => row.id === first.id)!.notificationId!;
  await expect
    .poll(
      async () => (await browserNotifications(page)).filter((item) => item.tag === notificationId),
      { timeout: 60_000 }
    )
    .toHaveLength(1);
  console.log(
    `3134 browser notification: reminder=${first.id} message=${first.messageId} notification=${notificationId}`
  );

  // Profile defaults to Pacific; read its actual zone instead of assuming the box's local clock.
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
  const releaseAt = new Date(now);
  releaseAt.setUTCSeconds(0, 0);
  releaseAt.setUTCMinutes(releaseAt.getUTCMinutes() + 3);
  await setQuiet(page, true, hhmm(new Date(now.getTime() - 300_000)), hhmm(releaseAt));
  await sendInMain(page, "remind me in 10 seconds to check the quiet proof timer");
  await expect(
    page.getByText("Reminder: check the quiet proof timer", { exact: true })
  ).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(
      () => reminderRows().find((row) => row.text === "check the quiet proof timer")?.notificationId
    )
    .not.toBeNull();
  const quiet = reminderRows().find((row) => row.text === "check the quiet proof timer")!;
  expect(new Date(quiet.deferredUntil!).getTime()).toBe(releaseAt.getTime());
  expect((await browserNotifications(page)).some((item) => item.tag === quiet.notificationId)).toBe(
    false
  );
  const response = await page.request.get("/api/notifications");
  expect(response.ok()).toBeTruthy();
  expect(
    ((await response.json()) as { notifications: { id: string }[] }).notifications.some(
      (item) => item.id === quiet.notificationId
    )
  ).toBe(false);
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  const reply = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/turn") && response.request().method() === "POST"
  );
  await composer.fill("I read the reminder. Reply with a short acknowledgement.");
  await composer.press("Enter");
  const modelResponse = await reply;
  expect(modelResponse.ok()).toBeTruthy();
  const modelBody = (await modelResponse.json()) as { reply: string };
  expect(modelBody.reply.trim().length).toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        (await browserNotifications(page)).filter(
          (item) => item.tag === `summary:${releaseAt.toISOString()}`
        ),
      { timeout: 240_000 }
    )
    .toHaveLength(1);
  console.log(
    `3134 quiet-hours release: reminder=${quiet.id} notification=${quiet.notificationId} release=${releaseAt.toISOString()} displayed once`
  );

  await setQuiet(page, false);
  await page.goto("/settings?section=modules&module=notifications");
  const mute = page.getByLabel("Notify from Chat");
  await page.locator("label.jds-switch").filter({ has: mute }).click();
  await expect(mute).not.toBeChecked();
  const before = (await browserNotifications(page)).length;
  await sendInMain(page, "remind me in 10 seconds to check the muted proof timer");
  await expect(
    page.getByText("Reminder: check the muted proof timer", { exact: true })
  ).toBeVisible({ timeout: 45_000 });
  const muted = reminderRows().find((row) => row.text === "check the muted proof timer")!;
  await expect
    .poll(() =>
      execUatSql(
        requireUatProjectName(),
        `SELECT state FROM pgboss.job WHERE name = 'chat.notify-reminder' AND data->>'resourceId' = '${muted.id}'`
      ).trim()
    )
    .toBe("completed");
  expect(reminderRows().find((row) => row.id === muted.id)!.notificationId).toBeNull();
  expect((await browserNotifications(page)).length).toBe(before);
  console.log(
    `3134 muted reminder: reminder=${muted.id} delivered in chat, no notification record or browser display`
  );

  await page.goto("/settings?section=modules&module=notifications");
  const unmute = page.getByLabel("Notify from Chat");
  await page.locator("label.jds-switch").filter({ has: unmute }).click();
  await expect(unmute).toBeChecked();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Registered for push notifications.")).toHaveCount(0);
  await sendInMain(page, "remind me in 10 seconds to check the disabled device timer");
  await expect(
    page.getByText("Reminder: check the disabled device timer", { exact: true })
  ).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(
      () =>
        reminderRows().find((row) => row.text === "check the disabled device timer")?.notificationId
    )
    .not.toBeNull();
  expect((await browserNotifications(page)).length).toBe(before);
  console.log(
    "3134 removed device: reminder stays in chat and Notifications, no further browser alert"
  );
});
