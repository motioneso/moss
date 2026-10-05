// Live-Path Gate for #2984 R2.6, part three: what chat does with the sorted, prepared tools.
//
// Runs after classifier-2984-r26-uat.spec.ts on the same instance and database. Every turn is a
// real chat turn on the owner's default model; every tool call that runs lands on the stand-in
// tool server, which is the only record of what Moss sent. Nothing is intercepted.
//
// Disclosed setup, all through the app's own routes except where noted:
// - the old connection is switched off, so chat sees one copy of the stand-in tools;
// - the classifier model is the sign-in's model that can return structured answers;
// - the gate mode is set through the admin route, not its screen;
// - for On, a shadow-review row is written by SQL (no screen or route writes it yet).
//
// Extra variables: LIVE_R26_DB_CONTAINER and LIVE_R26_DB name the scratch database for the
// shadow-record and activity-log reads.
import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";
import {
  EMAIL_TOOL,
  NEW_HUB,
  NOTIFY_TOOL,
  OLD_HUB,
  R26,
  SIZES,
  connectionId,
  openConnection,
  readDetail,
  shootBoth,
  signIn,
  sortOf,
  switchAllDevicesOff,
  toolServerCalls,
  deviceOn
} from "./classifier-2984-r26-helpers.js";

test.describe.configure({ mode: "serial" });

const SLUG = "new-smart-hub";
const LIGHT = "set_light_state";
const DEVICES = "list_devices";
const DOOR = "unlock_door";
const ACTION_CARD = '[role="region"][aria-label="Action request"]';

/** One read of the scratch database as its superuser. */
function sql(query: string): string {
  const container = process.env.LIVE_R26_DB_CONTAINER;
  const database = process.env.LIVE_R26_DB;
  if (!container || !database) throw new Error("set LIVE_R26_DB_CONTAINER and LIVE_R26_DB");
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-U", "postgres", "-d", database, "-Atc", query],
    { encoding: "utf8" }
  ).trim();
}

async function askInNewChat(page: Page, message: string): Promise<void> {
  await page.goto("/today");
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  await page.getByRole("button", { name: "New chat" }).click();
  // The page shows no ready signal for the background protocol start; give it a bounded settle.
  await page.waitForTimeout(20_000);
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
  await composer.fill(message);
  await composer.press("Enter");
}

/** Asks until the tool server records a new call with no card shown. A model may decline once. */
async function askUntilRan(page: Page, tool: string, message: string): Promise<number> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = (await toolServerCalls(tool)).length;
    await askInNewChat(page, message);
    const ran = await expect
      .poll(async () => (await toolServerCalls(tool)).length - before, { timeout: 150_000 })
      .toBeGreaterThanOrEqual(1)
      .then(() => true)
      .catch(() => false);
    await expect(page.locator(ACTION_CARD)).toHaveCount(0);
    if (ran) return (await toolServerCalls(tool)).length - before;
  }
  throw new Error(`${tool} never ran`);
}

/** Asks until an approval card shows. The tool server must not see the call. */
async function askUntilCard(page: Page, tool: string, message: string): Promise<void> {
  const before = (await toolServerCalls(tool)).length;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await askInNewChat(page, message);
    const asked = await expect(
      page.locator(ACTION_CARD).last().getByRole("button", { name: "Approve" })
    )
      .toBeVisible({ timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    expect((await toolServerCalls(tool)).length).toBe(before);
    if (asked) return;
  }
  throw new Error(`${tool} never asked`);
}

async function chatPictures(page: Page, name: string): Promise<void> {
  for (const [size, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }]
  ] as const) {
    await page.setViewportSize(viewport);
    // Lets the chat drawer finish moving so the picture is steady.
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: `${R26.shotDir}/${name}-${size}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function setGate(page: Page, mode: "off" | "shadow" | "on"): Promise<void> {
  const saved = await page.request.put("/api/admin/runtime-config/chat.classifier_gate_mode", {
    data: { value: mode }
  });
  expect(saved.ok(), `gate ${mode} -> ${saved.status()}`).toBe(true);
}

const call = (tool: string) => `"${SLUG}.${tool}"`;

test("7. setup for chat: one copy of the tools, YOLO off, a classifier model", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  // The rerun (classifier-2984-r26b-setup-uat.spec.ts) has no old connection to switch off.
  const oldId = await connectionId(page, OLD_HUB).catch(() => null);
  if (oldId) {
    const old = await page.request.patch(`/api/integrations/${oldId}`, {
      data: { enabled: false }
    });
    expect(old.ok(), `switch off old hub -> ${old.status()}`).toBe(true);
  }
  const yolo = await page.request.put("/api/me/yolo", { data: { enabled: false } });
  expect(yolo.ok() || yolo.status() === 403, `YOLO off -> ${yolo.status()}`).toBe(true);

  const models = (
    (await (await page.request.get("/api/ai/models")).json()) as {
      models: readonly { id: string; capabilities: readonly string[]; tier: string }[];
    }
  ).models;
  // LIVE_R26_CLASSIFIER_MODEL_ID pins the classifier to one configured model (the rerun uses a
  // small, fast API-key model); without it the first model that returns structured answers is used.
  const pinned = process.env.LIVE_R26_CLASSIFIER_MODEL_ID;
  const classifier = models.find((model) =>
    pinned ? model.id === pinned : model.capabilities.includes("json")
  );
  expect(classifier, "a model that can return structured answers").toBeTruthy();
  const bound = await page.request.put("/api/ai/services/sorting/binding", {
    data: { binding: { kind: "model", modelId: classifier!.id } }
  });
  expect(bound.ok(), `classifier model -> ${bound.status()}`).toBe(true);
  console.log("R2.6 classifier model:", JSON.stringify(classifier));
  await setGate(page, "off");
});

test("8. YOLO off: a safe tool runs with no card, and a Sensitive tool shows Asks first and asks", async ({
  page
}) => {
  test.setTimeout(900_000);
  await signIn(page);
  const detail = await readDetail(page, NEW_HUB);
  expect(sortOf(detail, LIGHT)).toMatchObject({ asksFirst: false });
  expect(sortOf(detail, DOOR)).toMatchObject({ risk: "destructive", asksFirst: true });

  await openConnection(page, NEW_HUB);
  const doorRow = page.locator(".intg-tool__id", { has: page.getByText(DOOR, { exact: true }) });
  await expect(doorRow.getByText("Asks first", { exact: true })).toBeVisible();
  await shootBoth(page, "r26-09-asks-first");

  const ran = await askUntilRan(
    page,
    LIGHT,
    `Call the tool named exactly ${call(LIGHT)} once with name "Kitchen light" and on true. ` +
      "Do it now, no questions."
  );
  console.log("R2.6 light calls:", ran);
  await page.waitForTimeout(5_000);
  await expect(page.locator(ACTION_CARD)).toHaveCount(0);
  await chatPictures(page, "r26-10-safe-runs");

  await askUntilCard(
    page,
    DOOR,
    `Call the tool named exactly ${call(DOOR)} once with door "front". Do it now, no questions.`
  );
  await chatPictures(page, "r26-11-sensitive-asks");
});

test("9. a Sends things out tool asks, runs once allowed from the group, asks again after Ask first for all", async ({
  page
}) => {
  test.setTimeout(1_200_000);
  await signIn(page);
  const notify =
    `Call the tool named exactly ${call(NOTIFY_TOOL)} once with message "Hub check done". ` +
    "Do it now, no questions.";
  await askUntilCard(page, NOTIFY_TOOL, notify);
  await chatPictures(page, "r26-12-sending-asks");

  await openConnection(page, NEW_HUB);
  await page.getByRole("button", { name: "Send all without asking" }).click();
  const confirm = page.getByRole("group", { name: "Send all without asking" });
  await confirm.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Sends without asking", { exact: true })).toHaveCount(2);
  await shootBoth(page, "r26-13-send-all-allowed");
  const allowed = await readDetail(page, NEW_HUB);
  expect(sortOf(allowed, NOTIFY_TOOL).sendWithoutAsking).toBe(true);
  expect(sortOf(allowed, EMAIL_TOOL).sendWithoutAsking).toBe(true);

  const ran = await askUntilRan(page, NOTIFY_TOOL, notify);
  expect(ran, "the notification went out exactly once").toBe(1);
  await page.waitForTimeout(5_000);
  await expect(page.locator(ACTION_CARD)).toHaveCount(0);
  await chatPictures(page, "r26-14-sending-runs");

  await openConnection(page, NEW_HUB);
  await page.getByRole("button", { name: "Ask first for all" }).click();
  await expect(page.getByText("Sends without asking", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send all without asking" })).toBeVisible();
  expect(sortOf(await readDetail(page, NEW_HUB), NOTIFY_TOOL).sendWithoutAsking).toBe(false);

  await askUntilCard(page, NOTIFY_TOOL, notify);
  await chatPictures(page, "r26-15-sending-asks-again");
});

test("10. a kept-out tool still works in chat and is never named in shadow records; released tools are", async ({
  page
}) => {
  test.setTimeout(1_200_000);
  await signIn(page);
  await openConnection(page, NEW_HUB);
  if (sortOf(await readDetail(page, NEW_HUB), DEVICES).classifierState !== "kept_out") {
    await page.getByRole("button", { name: `More for ${DEVICES}` }).click();
    await page.getByRole("menuitem", { name: /Keep out of the classifier/ }).click();
  }
  await expect
    .poll(async () => sortOf(await readDetail(page, NEW_HUB), DEVICES).classifierState)
    .toBe("kept_out");
  await shootBoth(page, "r26-16-kept-out");

  await setGate(page, "shadow");
  const since = sql("select now()::text");

  const devices = await askUntilRan(
    page,
    DEVICES,
    `Call the tool named exactly ${call(DEVICES)} once with no arguments. Do it now, no questions.`
  );
  console.log("R2.6 kept-out tool calls in chat:", devices);
  await chatPictures(page, "r26-17-kept-out-runs");
  // A connected look-up tool never joins the classifier's menu (its reply would only say the read
  // succeeded), so the released tool here is the light, a Changes things tool.
  await askUntilRan(page, LIGHT, "Turn the hallway light off with the hub tool.");

  // Every tool-name column, plus the outcome. The record keeps the message text by design, and this
  // prompt names the kept-out tool, so the text column is left out. The classifier here is a
  // small API-key model that answers well inside the 3-second gate limit.
  const rows = () =>
    sql(
      "select concat_ws('|', coalesce(module_id,'-'), coalesce(tool_name,'-'), " +
        "coalesce(model_tool_id,'-'), decision, coalesce(reason,'-'), " +
        "coalesce(latency_ms::text,'-'), comparison_status) " +
        `from app.chat_classifier_shadow_records where created_at > '${since}' order by created_at`
    )
      .split("\n")
      .filter(Boolean);
  await expect
    .poll(() => rows().filter((row) => !row.includes("|pending|")).length, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(2);
  const records = rows();
  console.log("R2.6 shadow records since the gate went to shadow:", JSON.stringify(records));
  const keptOutName = new RegExp(DEVICES.replace("_", "[._]"), "i");
  expect(records.filter((row) => keptOutName.test(row))).toEqual([]);
  expect(records.some((row) => new RegExp(LIGHT.replaceAll("_", "[._]"), "i").test(row))).toBe(
    true
  );
});

// Needs a classifier that answers inside the gate's fixed 3-second limit (#3036). The Codex
// sign-in does not; the rerun pins a small API-key model through LIVE_R26_CLASSIFIER_MODEL_ID.
test("11. YOLO handles a Sensitive tool only above its bar", async ({ page }) => {
  test.setTimeout(1_200_000);
  await signIn(page);
  const ownerId = sql(`select id from app.users where email = '${R26.ownerEmail}'`);
  const pinned = process.env.LIVE_R26_CLASSIFIER_MODEL_ID;
  const classifier = sql(
    "select m.id || '|' || m.provider_model_id from app.ai_configured_models m " +
      (pinned
        ? `where m.id = '${pinned}'`
        : "where m.capabilities @> array['json']::text[] limit 1")
  );
  const [modelId, providerModelId] = classifier.split("|");
  sql(
    "insert into app.chat_classifier_shadow_reviews " +
      "(classifier_model_id, classifier_provider_model_id, reviewed_by_user_id) values " +
      `('${modelId}', '${providerModelId}', '${ownerId}') on conflict do nothing`
  );
  await setGate(page, "on");
  for (const [route, data] of [
    ["/api/admin/yolo/instance", { enabled: true }],
    [`/api/admin/yolo/users/${ownerId}`, { allowed: true }],
    ["/api/me/yolo", { enabled: true }]
  ] as const) {
    const saved = await page.request.put(route, { data });
    expect(saved.ok(), `${route} -> ${saved.status()}`).toBe(true);
  }
  // Clears any 30-second cooldown left by the shadow turns.
  await page.waitForTimeout(35_000);

  const checks = (since: string) =>
    sql(
      "select outcome || '|' || coalesce(duration_ms::text,'-') || ' ms|' || " +
        "coalesce(fact_counts::text,'') from app.moss_model_activity_log " +
        `where action_code = 'chat.tool_check' and occurred_at > '${since}' order by occurred_at`
    )
      .split("\n")
      .filter(Boolean);

  const answers = (since: string) =>
    Number(
      sql(
        "select count(*) from app.moss_model_activity_log " +
          `where action_code = 'chat.answer' and occurred_at > '${since}'`
      )
    );
  const confidencesOf = (lines: readonly string[]) =>
    lines.flatMap((line) => {
      const match = /"confidence":\s*([0-9.]+)/.exec(line);
      return match ? [Number(match[1])] : [];
    });

  // One turn: ask in a new chat, wait until the door ran, a card showed, or the chat model
  // answered, then read what the classifier and the tool server recorded.
  const turn = async (label: string, message: string) => {
    await switchAllDevicesOff();
    const since = sql("select now()::text");
    const before = (await toolServerCalls(DOOR)).length;
    await askInNewChat(page, message);
    const card = page.locator(ACTION_CARD).last().getByRole("button", { name: "Approve" });
    await expect
      .poll(
        async () =>
          (await toolServerCalls(DOOR)).length > before ||
          (await card.isVisible()) ||
          answers(since) > 0,
        { timeout: 180_000, intervals: [3_000] }
      )
      .toBe(true);
    await page.waitForTimeout(20_000);
    const result = {
      ran: (await toolServerCalls(DOOR)).length > before,
      asked: await card.isVisible(),
      // The door ended up unlocked on the tool server and the chat shows no failure line.
      unlocked: await deviceOn("Front door"),
      failureShown: (await page.getByText(/did not complete|could not be confirmed/).count()) > 0,
      chatAnswers: answers(since),
      checks: checks(since)
    };
    const confidences = confidencesOf(result.checks);
    console.log(`R2.6 YOLO ${label}:`, JSON.stringify({ message, ...result, confidences }));
    await chatPictures(page, `r26-19-yolo-${label}`);
    return { ...result, confidences };
  };

  // Above the bar: both of the classifier's answers reach the Sensitive bar (0.95), so the gate runs
  // the door tool itself. No card shows and the chat model gives no answer of its own. A clear
  // request can still land under the bar on a given call, so a few phrasings are tried and each
  // one's confidences are logged.
  const clearAsks = [
    "Unlock the front door on my smart hub now.",
    "Use my smart hub to unlock the front door.",
    "Please unlock the front door lock with the smart hub tool unlock_door.",
    "Unlock the front door.",
    "Use the unlock door action on my new smart hub to unlock the front door right now.",
    "Smart hub: unlock the front door."
  ];
  let above = false;
  for (const [index, message] of clearAsks.entries()) {
    const result = await turn(`clear-${index + 1}`, message);
    if (
      result.ran &&
      result.unlocked &&
      !result.failureShown &&
      !result.asked &&
      result.chatAnswers === 0 &&
      result.confidences.length >= 2 &&
      result.confidences.every((value) => value >= 0.95)
    ) {
      above = true;
      break;
    }
    await page.waitForTimeout(35_000);
  }
  expect(
    above,
    "the gate ran the Sensitive tool itself above 0.95 and it completed: door unlocked, no card, no chat answer"
  ).toBe(true);

  // Below the bar: the gate declines and runs nothing itself. The chat model carries on (under YOLO
  // it may run the tool on its own judgment, which is the main model's call and not the gate's).
  const below = await turn("vague", "Hmm, maybe the door thing? Not sure, whatever you think.");
  expect(below.confidences.length, "the classifier decided the vague request").toBeGreaterThan(0);
  expect(
    below.confidences.some((value) => value < 0.95),
    "its confidence is under the Sensitive bar"
  ).toBe(true);
  expect(below.asked || below.chatAnswers > 0, "the chat model took over").toBe(true);

  const off = await page.request.put("/api/me/yolo", { data: { enabled: false } });
  expect(off.ok()).toBe(true);
});

test("12. the shadow report screen lists the records", async ({ page }) => {
  await signIn(page);
  const report = page.waitForResponse((response) =>
    response.url().includes("/api/chat/classifier/shadow-report")
  );
  await page.goto("/settings?section=shadowreport");
  expect((await report).ok()).toBe(true);
  await page.waitForTimeout(3_000);
  // No crowding check here: the admin side menu's group labels are 10px on main, outside this work.
  for (const [size, viewport] of SIZES) {
    await page.setViewportSize(viewport);
    await page.screenshot({
      path: `${R26.shotDir}/r26-18-shadow-report-${size}.png`,
      fullPage: true
    });
  }
});
