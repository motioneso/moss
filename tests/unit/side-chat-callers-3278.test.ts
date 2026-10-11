import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface SpecRules {
  readonly file: string;
  /** The call that starts the side chat, and the send it must precede. */
  readonly start: string;
  readonly send: string;
  /** The check that the side chat's turn landed in a different conversation. */
  readonly freshThread: RegExp;
  readonly screenshots: number;
  readonly extra: (text: string) => string[];
  /** Every assertion the move to the Conversations controls must keep, verbatim, with its count. */
  readonly kept: readonly (readonly [string, number])[];
}

const APP_ACTIONS: SpecRules = {
  file: "3065-app-actions-real.uat.spec.ts",
  start: "await startSideChat(page, drawer);",
  send: 'const turn = await startTurn(\n        page,\n        drawer,\n        "What proof phrase',
  freshThread: /expect\(proof\.threadId, "[^"]+"\)\.not\.toBe\(nativeThreadId\);/,
  screenshots: 0,
  extra: (text) => {
    const found: string[] = [];
    const guard = /function requireDisposableStack\(\): void \{[\s\S]*?\n}\n/.exec(text)?.[0] ?? "";
    if (
      !/disposableStackProblems\(\{[\s\S]*baseURL: requireUatBaseURL\(\),[\s\S]*projectName: requireUatProjectName\(\),[\s\S]*claimedWebPort: readClaimedWebPort\(\)[\s\S]*\}\)/.test(
        guard
      ) ||
      !/\)\.toEqual\(\[\]\);/.test(guard)
    ) {
      found.push("the stack check does not use the claimed-port rules");
    }
    if (!/\n {4}requireDisposableStack\(\);\n {4}await signInUatAdmin\(page\);/.test(text)) {
      found.push("the stack check does not run before sign-in");
    }
    return found;
  },
  kept: [
    ['expect(message?.status).toBe("stored");', 1],
    ['expect(message?.origin, "classifier handling is not real-model proof").toBeUndefined();', 1],
    ["await expect(card.getByText(NOTICE, { exact: true })).toBeVisible();", 2],
    ["expect(await cardTool(card)).toBe(tool);", 1],
    ['await expect(card).not.toContainText("/api/me/themes/mode");', 1],
    ['await expect(card).not.toContainText("app.callAction");', 1],
    ['expect((await themes(page)).mode, "must remain unchanged before approval")', 1],
    ["expect(proof.tainted).toBe(true);", 2],
    ['"screen must update without reload"', 1],
    ['"unsupported native permission tool; do not approve"', 1],
    ['"native command summary must match exactly, without normalization or truncation"', 1],
    ['"native file read did not return the fresh fixture fact"', 1],
    ['"missing exact-path native read activity; unsupported engine is not a pass"', 1],
    ['"the instruction inside the file must not auto-change theme"', 1],
    ['message: "real notes ingestion did not finish; this is not a recall pass"', 1],
    ["expect(proof.message.body).toContain(recallFact);", 1],
    ['"the fact must arrive by automatic recall, with no notes/native tool call"', 1],
    ['await approveThemeChange(page, drawer, "app.callAction", "dark");', 2],
    ['await approveThemeChange(page, drawer, "settings.themeMode.set", "light");', 1],
    ['await expect(card.locator(".action-request-target")).toHaveText(theme.name);', 1],
    ["expect((await themes(page)).custom.some((item) => item.id === theme.id)).toBe(true);", 1],
    ["await expect(galleryCard).toHaveCount(0);", 1],
    ["expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);", 1],
    ["expect(toolCalls(proof).some((name) => /app[._]callAction$/.test(name))).toBe(true);", 1],
    ['expect(await readUatJson(await page.request.get("/api/me/yolo"))).toEqual(before);', 1],
    ["await expect(pendingCard(drawer)).toHaveCount(0);", 2]
  ]
};

const BRIEFING: SpecRules = {
  file: "2809-briefing-rerun-from-chat.uat.spec.ts",
  start: "await startSideChat(page, dialog);",
  send: "const second = await ask(dialog, RERUN_ASK);",
  freshThread: /expect\(await drawerThreadId\(page\), "[^"]+"\)\.not\.toBe\(\s*firstThread\s*\);/,
  screenshots: 3,
  extra: () => [],
  kept: [
    ["expect(openRunJobs(definitionId)).toHaveLength(0);", 2],
    ["await expect(rerunOutcome).toHaveCount(1);", 2],
    ["await expect(rerunOutcome).toBeVisible();", 2],
    ['dialog.getByRole("status").filter({ hasText: "Executed: briefings.rerun" })', 2],
    ['await expect(dialog.getByRole("button", { name: "Approve" })).toHaveCount(0);', 2],
    [
      "expect(first.visible).toMatch(/queued|started|kicked off|re-?running|being written|underway/i);",
      1
    ],
    ['expect(rerunAuditRows()).toEqual([{ approvalMode: "auto", outcome: "success" }]);', 1],
    ["expect(afterFirst).toHaveLength(1);", 1],
    ["expect(second.visible).toMatch(/already/i);", 1],
    ["expect(afterSecond.map((job) => job.id)).toEqual(afterFirst.map((job) => job.id));", 1],
    ['.toEqual(["succeeded"]);', 1],
    ["expect(third.visible).toMatch(/ready|done|finished|complete/i);", 1],
    ["expect(third.steps).toMatch(/getRunStatus/i);", 1],
    ["expect(rerunAuditRows()).toHaveLength(2);", 1]
  ]
};

const source = (file: string) => readFile(new URL(`../uat/specs/${file}`, import.meta.url), "utf8");

/** Every problem a spec has with fresh chats, captures or kept assertions. */
function problems(rules: SpecRules, text: string): string[] {
  const found: string[] = [];
  if (/name: "New chat"/.test(text)) found.push("clicks the removed New chat button");

  const opens = text.match(/name: "Open conversations"/g) ?? [];
  const sides = text.match(/name: "New side chat", exact: true/g) ?? [];
  if (opens.length === 0) found.push("never opens Conversations");
  if (sides.length !== opens.length) found.push("an overlay open does not start a side chat");

  const helper = /async function startSideChat\([^)]*\)[\s\S]*?\n}\n/.exec(text)?.[0] ?? "";
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

  const start = text.indexOf(rules.start);
  const send = text.indexOf(rules.send);
  if (start < 0 || send < 0 || start > send || text.lastIndexOf(rules.start) !== start) {
    found.push("does not start exactly one side chat before the next send");
  }
  if (!rules.freshThread.test(text)) found.push("does not prove the side chat is a new thread");

  const direct = text.match(/\.screenshot\(/g) ?? [];
  const guarded =
    text.match(/if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+await [^;]*?\.screenshot\(/g) ??
    [];
  if (direct.length !== rules.screenshots) {
    found.push(`expected ${rules.screenshots} screenshots, found ${direct.length}`);
  }
  if (guarded.length !== direct.length) found.push("a screenshot ignores the capture opt-out");

  for (const [assertion, count] of rules.kept) {
    if (text.split(assertion).length - 1 < count) found.push(`lost assertion: ${assertion}`);
  }
  return [...found, ...rules.extra(text)];
}

const mutate = async (rules: SpecRules, from: string | RegExp, to: string) => {
  const text = await source(rules.file);
  const next = text.replace(from, to);
  expect(next, `mutation did not apply: ${String(from)}`).not.toBe(text);
  return problems(rules, next);
};

describe.each([APP_ACTIONS, BRIEFING])("$file on the Conversations controls (#3278)", (rules) => {
  it("starts its fresh chat through Conversations, guards captures, keeps its assertions", async () => {
    expect(problems(rules, await source(rules.file))).toEqual([]);
  });

  describe("negative controls: the guard catches each regression", () => {
    it("the removed New chat button", async () => {
      expect(
        await mutate(
          rules,
          rules.start,
          'await page.getByRole("button", { name: "New chat" }).click();'
        )
      ).toEqual(
        expect.arrayContaining([
          "clicks the removed New chat button",
          "does not start exactly one side chat before the next send"
        ])
      );
    });

    it("an overlay open with no side chat", async () => {
      expect(
        await mutate(rules, '{ name: "New side chat", exact: true }', '{ name: "Main" }')
      ).toContain("an overlay open does not start a side chat");
    });

    it("no wait for the drawer clear", async () => {
      expect(
        await mutate(rules, 'url.pathname === "/api/chat/clear"', 'url.pathname === "/api/chat"')
      ).toContain("side chat does not wait for the drawer clear");
    });

    it("a clear on the wrong surface", async () => {
      expect(
        await mutate(rules, 'get("surface") === "drawer"', 'get("surface") === "main"')
      ).toContain("side chat waits for a clear on the wrong surface");
    });

    it("no check that the clear succeeded", async () => {
      expect(
        await mutate(rules, "expect((await cleared).status()).toBe(204);", "await cleared;")
      ).toContain("side chat does not check the clear succeeded");
    });

    it("no wait for an empty reply list", async () => {
      expect(
        await mutate(rules, /\n {2}await expect\([a-z]+\.locator\("\.chatd-msg:not[^\n]*\n/, "\n")
      ).toContain("side chat does not wait for an empty reply list");
    });

    it("sending before the side chat starts", async () => {
      const text = await source(rules.file);
      const moved = text
        .replace(rules.start, "")
        .replace(rules.send, `${rules.send}\n${rules.start}`);
      expect(problems(rules, moved)).toContain(
        "does not start exactly one side chat before the next send"
      );
    });

    it("no proof of a new thread", async () => {
      expect(await mutate(rules, rules.freshThread, "")).toContain(
        "does not prove the side chat is a new thread"
      );
    });

    it("a dropped kept assertion", async () => {
      const [assertion] = rules.kept.at(-1)!;
      expect(await mutate(rules, assertion, "")).toContain(`lost assertion: ${assertion}`);
    });
  });
});

describe("capture and stack-check controls (#3278)", () => {
  it("catches an unguarded briefing screenshot", async () => {
    expect(
      await mutate(
        BRIEFING,
        /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+(await dialog\.screenshot)/,
        "$1"
      )
    ).toContain("a screenshot ignores the capture opt-out");
  });

  it("catches a dropped briefing screenshot", async () => {
    expect(
      await mutate(
        BRIEFING,
        /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+await dialog\.screenshot\([^;]*;/,
        ""
      )
    ).toContain("expected 3 screenshots, found 2");
  });

  it("catches a stack check that ignores the claimed port", async () => {
    expect(
      await mutate(APP_ACTIONS, "claimedWebPort: readClaimedWebPort()", "claimedWebPort: undefined")
    ).toContain("the stack check does not use the claimed-port rules");
  });

  it("catches a stack check that no longer runs before sign-in", async () => {
    expect(await mutate(APP_ACTIONS, /\n {4}requireDisposableStack\(\);\n/, "\n")).toContain(
      "the stack check does not run before sign-in"
    );
  });
});
