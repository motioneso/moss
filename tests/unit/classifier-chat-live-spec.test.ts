import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireOwnInstance } from "../live/own-instance.js";
import { uatRealChatProvider } from "../uat/real-chat-env.js";

interface Sources {
  readonly chat: string;
  readonly helpers: string;
  readonly setup: string;
  readonly config: string;
}

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

async function sources(): Promise<Sources> {
  return {
    chat: await read("tests/live/classifier-2984-r26-chat-uat.spec.ts"),
    helpers: await read("tests/live/classifier-2984-r26-helpers.ts"),
    setup: await read("tests/live/classifier-2984-r26b-setup-uat.spec.ts"),
    config: await read("playwright.live.config.ts")
  };
}

// Every behavioural assertion the chat spec must keep, verbatim, with its count.
const KEPT_CHAT_ASSERTIONS: readonly (readonly [string, number])[] = [
  ["await expect(composer).toBeEnabled();", 1],
  ["await expect(page.locator(ACTION_CARD).last().getByText(MARKED_NOTICE)).toHaveCount(", 1],
  ["        freshChatRuns ? 1 : 0\n", 1],
  ["  await askUntilCard(page, NOTIFY_TOOL, notify, false);", 2],
  ["  await askUntilCard(page, NOTIFY_TOOL, notify, true);", 1],
  ['"Do it now, no questions.",\n    true\n', 1],
  ['once with door "front". Do it now, no questions.`,\n    false\n', 1],
  ["once with no arguments. Do it now, no questions.`,\n    true\n", 1],
  ['  await askUntilCard(page, LIGHT, "Turn the hallway light off with the hub tool.", true);', 1],
  ["await askUntilCard(", 7],
  [".toBeVisible({ timeout: 180_000 })", 1],
  ["expect((await toolServerCalls(tool)).length).toBe(before);", 1],
  ["expect(old.ok(), `switch off old hub -> ${old.status()}`).toBe(true);", 1],
  ["expect(yolo.ok() || yolo.status() === 403, `YOLO off -> ${yolo.status()}`).toBe(true);", 1],
  ['expect(classifier, "a model that can return structured answers").toBeTruthy();', 1],
  ['expect(classifier, "the classifier model test 7 bound").toBeTruthy();', 1],
  ["          answers(since) > 0,\n        { timeout: 180_000, intervals: [3_000] }", 1],
  ["expect(bound.ok(), `classifier model -> ${bound.status()}`).toBe(true);", 1],
  ["expect(saved.ok(), `gate ${mode} -> ${saved.status()}`).toBe(true);", 1],
  ["expect(sortOf(detail, LIGHT)).toMatchObject({ asksFirst: false });", 1],
  ['expect(sortOf(detail, DOOR)).toMatchObject({ risk: "destructive", asksFirst: true });', 1],
  ['await expect(doorRow.getByText("Asks first", { exact: true })).toBeVisible();', 1],
  ['await expect(page.getByText("Sends without asking", { exact: true })).toHaveCount(2);', 1],
  ['await expect(page.getByText("Sends without asking", { exact: true })).toHaveCount(0);', 1],
  ["expect(sortOf(allowed, NOTIFY_TOOL).sendWithoutAsking).toBe(true);", 1],
  ["expect(sortOf(allowed, EMAIL_TOOL).sendWithoutAsking).toBe(true);", 1],
  ['await expect(page.getByRole("button", { name: "Send all without asking" })).toBeVisible();', 1],
  [
    "expect(sortOf(await readDetail(page, NEW_HUB), NOTIFY_TOOL).sendWithoutAsking).toBe(false);",
    1
  ],
  ['.toBe("kept_out");', 1],
  [".toBeGreaterThanOrEqual(2);", 1],
  ["expect(records.filter((row) => keptOutName.test(row))).toEqual([]);", 1],
  ['expect(records.some((row) => new RegExp(LIGHT.replaceAll("_", "[._]"), "i").test(row))).', 1],
  ["expect(saved.ok(), `${route} -> ${saved.status()}`).toBe(true);", 1],
  [
    'expect(result.ran || result.unlocked, "nothing unlocked the door in a marked chat").toBe(false);',
    1
  ],
  [
    'expect(below.ran || below.unlocked, "nothing unlocked the door in a marked chat").toBe(false);',
    1
  ],
  [
    "if (result.confidences.length >= 2 && result.confidences.every((value) => value >= 0.95)) {",
    1
  ],
  ['expect(result.asked || result.chatAnswers > 0, "the chat model took over").toBe(true);', 1],
  ["JSON.stringify({ message, ...result, confidences, perQuestionMs, limitMs })", 1],
  ["const limitMs = gateLimitMs(since);", 1],
  ["record.record(modelId, (timedOut >= 0 ? timedOut : total) / asked);", 1],
  ['expect(summary.checked, "shadow records reached the report").toBeGreaterThanOrEqual(1);', 1],
  ['.locator(".set-row__control")\n  ).toHaveText(String(summary.checked));', 1],
  ['console.log("R2.6 YOLO a clear ask reached the Sensitive bar:", above);', 1],
  ["\"action_code in ('chat.tool_check', 'structured.worker')\";", 1],
  ["`where ${gateCalls} and occurred_at > '${since}' order by occurred_at`", 1],
  ["`from app.moss_model_activity_log where ${gateCalls} ` +", 1],
  ['expect(below.asked || below.chatAnswers > 0, "the chat model took over").toBe(true);', 1],
  ["expect(off.ok()).toBe(true);", 1],
  ["expect((await report).ok()).toBe(true);", 1]
];

// The reachable pre-#3388 runs, under the current marked-chat YOLO rule.
const RESTORED_RUN_ASSERTIONS: readonly (readonly [string, number])[] = [
  ["if (ran) await page.waitForTimeout(5_000);", 1],
  [
    "async function askUntilRan(page: Page, tool: string, message: string): Promise<number> {\n" +
      "  const before = (await toolServerCalls(tool)).length;\n" +
      "  for (let attempt = 1; attempt <= 2; attempt++) {",
    1
  ],
  [".poll(async () => (await toolServerCalls(tool)).length - before, { timeout: 150_000 })", 1],
  ["      .toBeGreaterThanOrEqual(1)\n      .then(() => true)", 1],
  ["await expect(page.locator(ACTION_CARD)).toHaveCount(0);", 3],
  ["const ran = await askUntilRan(\n    page,\n    LIGHT,", 1],
  ["const ran = await askUntilRan(page, NOTIFY_TOOL, notify);", 1],
  ['expect(ran, "the notification went out exactly once").toBe(1);', 1],
  ["const devices = await askUntilRan(\n    page,\n    DEVICES,", 1],
  ['await askUntilRan(page, LIGHT, "Turn the hallway light off with the hub tool.");', 1],
  ["await setYolo(page, true);", 4],
  ["await setYolo(page, false);", 4],
  ['await setGate(page, "on");\n  await setYolo(page, false);', 1],
  [
    "      outcome.ran &&\n      outcome.unlocked &&\n      !outcome.failureShown &&\n      !outcome.asked &&\n      outcome.chatAnswers === 0",
    1
  ],
  ["    handled,\n", 1],
  ['expect(above, "both classifier answers reach the Sensitive bar").toBe(true);', 1],
  [
    'expect(yoloBelow.asked || yoloBelow.chatAnswers > 0, "the chat model took over").toBe(true);',
    1
  ],
  ["      yoloBelow.confidences.some((value) => value < 0.95),", 1]
];

const KEPT_SETUP_ASSERTIONS: readonly (readonly [string, number])[] = [
  ['expect((await install.json()).installState).toBe("installed");', 1],
  ['expect((await login.json()).status).toBe("ready");', 1],
  ["expect(bound.ok(), `${service} binding -> ${bound.status()}`).toBe(true);", 1],
  ['await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible();', 1],
  [".toHaveCount(1, { timeout: 300_000 });", 1],
  ['.not.toEqual(expect.arrayContaining(["preparing"]));', 1],
  ['.not.toEqual(expect.arrayContaining(["preparing_again"]));', 1]
];

const GUARDED_SHOT =
  /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+await page\.screenshot\(/g;

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every problem the classifier live journey has with fresh chats, captures or kept checks. */
function problems({ chat, helpers, setup, config }: Sources): string[] {
  const found: string[] = [];
  if (/name: "New chat"/.test(chat)) found.push("clicks the removed New chat button");

  const helper = /async function startSideChat\(page: Page\)[\s\S]*?\n}\n/.exec(chat)?.[0] ?? "";
  const open = helper.indexOf('{ name: "Open conversations" }');
  const side = helper.indexOf('{ name: "New side chat", exact: true }');
  if (open < 0) found.push("never opens Conversations");
  if (side < 0 || side < open) found.push("an overlay open does not start a side chat");
  if (!/url\.pathname === "\/api\/chat\/clear"/.test(helper)) {
    found.push("side chat does not wait for the drawer clear");
  }
  if (!/url\.searchParams\.get\("surface"\) === "drawer"/.test(helper)) {
    found.push("side chat waits for a clear on the wrong surface");
  }
  if (!/expect\(\(await cleared\)\.status\(\)\)\.toBe\(204\)/.test(helper)) {
    found.push("side chat does not check the clear succeeded");
  }
  if (!/\.chatd-msg:not\(\.chatd-msg--me\) \.chatd-bubble"\)\)\.toHaveCount\(0\)/.test(helper)) {
    found.push("side chat does not wait for an empty reply list");
  }

  const ask = /async function askInNewChat[\s\S]*?\n}\n/.exec(chat)?.[0] ?? "";
  const start = ask.indexOf("await startSideChat(page);");
  const send = ask.indexOf("await composer.fill(message);");
  if (start < 0 || send < 0 || start > send) found.push("sends before starting a side chat");

  // chatPictures and the shadow report each take one; shootBoth takes the helper's one.
  const chatShots = countOf(chat, ".screenshot(");
  if (chatShots !== 2) found.push(`expected 2 chat spec screenshots, found ${chatShots}`);
  if ((chat.match(GUARDED_SHOT) ?? []).length !== chatShots) {
    found.push("a chat spec screenshot ignores the capture opt-out");
  }
  const shoot = /export async function shootBoth[\s\S]*?\n}\n/.exec(helpers)?.[0] ?? "";
  if ((shoot.match(GUARDED_SHOT) ?? []).length !== 1 || countOf(helpers, ".screenshot(") !== 1) {
    found.push("the two-size helper's screenshot ignores the capture opt-out");
  }
  const crowd = shoot.indexOf("await assertNoCrowding(page, `${name} ${size}`);");
  if (crowd < 0 || crowd > shoot.indexOf(".screenshot(")) {
    found.push("the two-size helper lost its crowding check");
  }
  if (!helpers.includes("expect(problems, `crowding at ${label}`).toEqual([]);")) {
    found.push("the crowding check no longer fails on a problem");
  }

  const signIn = /export async function signIn[\s\S]*?\n}\n/.exec(helpers)?.[0] ?? "";
  if (!/^\s+requireOwnInstance\(\);/m.test(signIn))
    found.push("sign-in skips the own-instance check");
  if (!/^\s+requireOwnInstance\(\);\n\s+await setToolServerTools/m.test(setup)) {
    found.push("setup skips the own-instance check");
  }
  if (!/^\s+const provider = uatRealChatProvider\(\);/m.test(setup)) {
    found.push("setup picks its sign-in without the capture refusal");
  }
  if (!/trace: process\.env\.MOSS_UAT_CAPTURE_OFF === "1" \? "off"/.test(config)) {
    found.push("the live config keeps traces under the capture opt-out");
  }

  for (const [assertion, count] of KEPT_CHAT_ASSERTIONS) {
    if (countOf(chat, assertion) < count) found.push(`lost assertion: ${assertion}`);
  }
  for (const [assertion, count] of RESTORED_RUN_ASSERTIONS) {
    if (countOf(chat, assertion) < count) found.push(`lost restored run check: ${assertion}`);
  }
  for (const [assertion, count] of KEPT_SETUP_ASSERTIONS) {
    if (countOf(setup, assertion) < count) found.push(`lost setup assertion: ${assertion}`);
  }
  return found;
}

describe("classifier chat live journey (#3362)", () => {
  it("starts every fresh chat through Conversations, guards captures, keeps its checks", async () => {
    expect(problems(await sources())).toEqual([]);
  });

  describe("negative controls: the guard catches each regression", () => {
    const mutate = async (file: keyof Sources, from: string | RegExp, to: string) => {
      const all = await sources();
      const next = all[file].replace(from, to);
      expect(next, `mutation did not apply: ${String(from)}`).not.toBe(all[file]);
      return problems({ ...all, [file]: next });
    };

    it.each(RESTORED_RUN_ASSERTIONS)("lost restored run check: %s", async (assertion) => {
      expect(await mutate("chat", assertion, "")).toContain(
        `lost restored run check: ${assertion}`
      );
    });

    it("the removed New chat button", async () => {
      expect(
        await mutate(
          "chat",
          "  await startSideChat(page);\n",
          '  await page.getByRole("button", { name: "New chat" }).click();\n'
        )
      ).toEqual(
        expect.arrayContaining([
          "clicks the removed New chat button",
          "sends before starting a side chat"
        ])
      );
    });

    it("an overlay open with no side chat", async () => {
      expect(
        await mutate("chat", '{ name: "New side chat", exact: true }', '{ name: "Main" }')
      ).toContain("an overlay open does not start a side chat");
    });

    it("no wait for the drawer clear", async () => {
      expect(
        await mutate("chat", 'url.pathname === "/api/chat/clear"', 'url.pathname === "/api/chat"')
      ).toContain("side chat does not wait for the drawer clear");
    });

    it("a clear on the wrong surface", async () => {
      expect(
        await mutate("chat", 'get("surface") === "drawer"', 'get("surface") === "main"')
      ).toContain("side chat waits for a clear on the wrong surface");
    });

    it("no check that the clear succeeded", async () => {
      expect(
        await mutate("chat", "expect((await cleared).status()).toBe(204);", "await cleared;")
      ).toContain("side chat does not check the clear succeeded");
    });

    it("no wait for an empty reply list", async () => {
      expect(
        await mutate("chat", /\n {2}await expect\(page\.locator\("\.chatd-msg:not[^\n]*\n/, "\n")
      ).toContain("side chat does not wait for an empty reply list");
    });

    it("an unguarded chat picture", async () => {
      expect(
        await mutate(
          "chat",
          /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+(await page\.screenshot\(\{ path: `\$\{R26\.shotDir\}\/\$\{name\})/,
          "$1"
        )
      ).toContain("a chat spec screenshot ignores the capture opt-out");
    });

    it("an unguarded shadow report picture", async () => {
      expect(
        await mutate(
          "chat",
          /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+(await page\.screenshot\(\{\n)/,
          "$1"
        )
      ).toContain("a chat spec screenshot ignores the capture opt-out");
    });

    it("an unguarded two-size picture", async () => {
      expect(
        await mutate(
          "helpers",
          /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+(await page\.screenshot)/,
          "$1"
        )
      ).toContain("the two-size helper's screenshot ignores the capture opt-out");
    });

    it("the two-size helper's crowding check dropped", async () => {
      expect(
        await mutate("helpers", "    await assertNoCrowding(page, `${name} ${size}`);\n", "")
      ).toContain("the two-size helper lost its crowding check");
    });

    it("sign-in without the own-instance check", async () => {
      expect(
        await mutate("helpers", "  requireOwnInstance();\n  await page.goto", "  await page.goto")
      ).toContain("sign-in skips the own-instance check");
    });

    it("setup without the own-instance check", async () => {
      expect(await mutate("setup", "  requireOwnInstance();\n", "")).toContain(
        "setup skips the own-instance check"
      );
    });

    it("setup picking its sign-in without the capture refusal", async () => {
      expect(
        await mutate(
          "setup",
          "  const provider = uatRealChatProvider();",
          '  const provider = process.env.JARVIS_UAT_REAL_CHAT_PROVIDER ?? "codex";'
        )
      ).toContain("setup picks its sign-in without the capture refusal");
    });

    it("traces kept under the capture opt-out", async () => {
      expect(
        await mutate(
          "config",
          /trace: process\.env\.MOSS_UAT_CAPTURE_OFF === "1" \? "off" : "retain-on-failure"/,
          'trace: "retain-on-failure"'
        )
      ).toContain("the live config keeps traces under the capture opt-out");
    });

    it("the outside-content line check dropped from an ask", async () => {
      expect(
        await mutate(
          "chat",
          "      await expect(page.locator(ACTION_CARD).last().getByText(MARKED_NOTICE)).toHaveCount(\n" +
            "        freshChatRuns ? 1 : 0\n" +
            "      );\n",
          ""
        )
      ).toContain(
        "lost assertion: await expect(page.locator(ACTION_CARD).last().getByText(MARKED_NOTICE)).toHaveCount("
      );
    });

    it("an ask turned back into an unchecked chat turn", async () => {
      expect(
        await mutate("chat", "  await askUntilCard(page, NOTIFY_TOOL, notify, true);\n", "")
      ).toContain("lost assertion: await askUntilCard(");
    });

    it("the gate's door-locked check dropped", async () => {
      expect(
        await mutate(
          "chat",
          '  expect(result.ran || result.unlocked, "nothing unlocked the door in a marked chat").toBe(false);\n',
          ""
        )
      ).toContain(
        'lost assertion: expect(result.ran || result.unlocked, "nothing unlocked the door in a marked chat").toBe(false);'
      );
    });

    it("the tool server's no-call check dropped from an ask", async () => {
      expect(
        await mutate("chat", "    expect((await toolServerCalls(tool)).length).toBe(before);\n", "")
      ).toContain("lost assertion: expect((await toolServerCalls(tool)).length).toBe(before);");
    });

    it("the kept-out shadow check dropped", async () => {
      expect(
        await mutate(
          "chat",
          "  expect(records.filter((row) => keptOutName.test(row))).toEqual([]);\n",
          ""
        )
      ).toContain(
        "lost assertion: expect(records.filter((row) => keptOutName.test(row))).toEqual([]);"
      );
    });

    it("the sorting wait dropped from setup", async () => {
      expect(
        await mutate("setup", ".toHaveCount(1, { timeout: 300_000 });", ".toBeVisible();")
      ).toContain("lost setup assertion: .toHaveCount(1, { timeout: 300_000 });");
    });
  });

  describe("a run refuses shared instances", () => {
    it.each([
      ["unset", undefined],
      ["dev's screen", "http://127.0.0.1:5173"],
      ["dev over https", "https://dev.example.ts.net:5443"],
      ["prod", "http://127.0.0.1:1533"],
      ["no port", "https://moss.example.com"]
    ])("refuses %s", (_label, baseUrl) => {
      expect(() => requireOwnInstance(baseUrl)).toThrow(/LIVE_BASE_URL/);
    });

    it("accepts a claimed dev port", () => {
      expect(() => requireOwnInstance("http://127.0.0.1:5187")).not.toThrow();
    });
  });

  describe("a Claude run refuses captures", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("throws without the capture opt-out", () => {
      vi.stubEnv("JARVIS_UAT_REAL_CHAT_PROVIDER", "claude");
      vi.stubEnv("MOSS_UAT_CAPTURE_OFF", "");
      expect(() => uatRealChatProvider()).toThrow(/MOSS_UAT_CAPTURE_OFF=1/);
    });

    it("runs with the opt-out", () => {
      vi.stubEnv("JARVIS_UAT_REAL_CHAT_PROVIDER", "claude");
      vi.stubEnv("MOSS_UAT_CAPTURE_OFF", "1");
      expect(uatRealChatProvider()).toBe("claude");
    });
  });
});
