import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SPEC = "2984-safe-tools-run.uat.spec.ts";

const source = () => readFile(new URL(`../uat/specs/${SPEC}`, import.meta.url), "utf8");

// Every assertion the move to the Conversations controls must keep, verbatim, with its count.
const KEPT_ASSERTIONS: readonly (readonly [string, number])[] = [
  ["await expect(composer).toBeEnabled();", 1],
  ["await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });", 1],
  ["await expect(userMenu).toBeVisible();", 1],
  ["await expect(page.getByText(FIXTURE_LIGHT_TOOL).first()).toBeVisible({ timeout: 30_000 });", 1],
  [".toBeVisible({ timeout: 180_000 })", 1],
  ['.toEqual(["current", "current"]);', 1],
  ["expect(tools.get(FIXTURE_LIGHT_TOOL)).toMatchObject({ asksFirst: false });", 1],
  ['expect(tools.get(RESET_TOOL)).toMatchObject({ risk: "destructive", asksFirst: true });', 1],
  [
    "expect(yolo.ok() || yolo.status() === 403, `PUT /api/me/yolo -> ${yolo.status()}`).toBe(true);",
    1
  ],
  [".toBeGreaterThanOrEqual(1)", 1],
  ["await expect(page.locator(ACTION_CARD)).toHaveCount(0);", 2],
  ['expect(ran, "the light call reached the service without a card").toBe(true);', 1],
  ["expect(asked, `the reset tool asked first at ${name} width`).toBe(true);", 1],
  ["expect(callsTo(RESET_TOOL)).toHaveLength(0);", 1]
];

/** Every problem the 2984 spec has with fresh chats, captures or kept assertions. */
function problems(text: string): string[] {
  const found: string[] = [];
  if (/name: "New chat"/.test(text)) found.push("clicks the removed New chat button");

  const opens = text.match(/name: "Open conversations"/g) ?? [];
  const sides = text.match(/name: "New side chat", exact: true/g) ?? [];
  if (opens.length === 0) found.push("never opens Conversations");
  if (sides.length !== opens.length) found.push("an overlay open does not start a side chat");

  const helper = /async function startSideChat\(page: Page\)[\s\S]*?\n}\n/.exec(text)?.[0] ?? "";
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

  const ask = /async function askInNewChat[\s\S]*?\n}\n/.exec(text)?.[0] ?? "";
  const start = ask.indexOf("await startSideChat(page);");
  const send = ask.indexOf("await composer.fill(message);");
  if (start < 0 || send < 0 || start > send) found.push("sends before starting a side chat");

  const direct = text.match(/\.screenshot\(/g) ?? [];
  const guarded =
    text.match(/if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+await [^;]*?\.screenshot\(/g) ??
    [];
  if (direct.length !== 2) found.push(`expected 2 screenshots, found ${direct.length}`);
  if (guarded.length !== direct.length) found.push("a screenshot ignores the capture opt-out");

  for (const [assertion, count] of KEPT_ASSERTIONS) {
    if (text.split(assertion).length - 1 < count) found.push(`lost assertion: ${assertion}`);
  }
  return found;
}

describe("connected-tools safety live spec (#3361)", () => {
  it("starts every fresh chat through Conversations, guards captures, keeps its assertions", async () => {
    expect(problems(await source())).toEqual([]);
  });

  describe("negative controls: the guard catches each regression", () => {
    const mutate = async (from: string | RegExp, to: string) => {
      const text = await source();
      const next = text.replace(from, to);
      expect(next, `mutation did not apply: ${String(from)}`).not.toBe(text);
      return problems(next);
    };

    it("the removed New chat button", async () => {
      expect(
        await mutate(
          "await startSideChat(page);",
          'await page.getByRole("button", { name: "New chat" }).click();'
        )
      ).toEqual(
        expect.arrayContaining([
          "clicks the removed New chat button",
          "sends before starting a side chat"
        ])
      );
    });

    it("an overlay open with no side chat", async () => {
      expect(await mutate('{ name: "New side chat", exact: true }', '{ name: "Main" }')).toContain(
        "an overlay open does not start a side chat"
      );
    });

    it("no wait for the drawer clear", async () => {
      expect(
        await mutate('url.pathname === "/api/chat/clear"', 'url.pathname === "/api/chat"')
      ).toContain("side chat does not wait for the drawer clear");
    });

    it("a clear on the wrong surface", async () => {
      expect(await mutate('get("surface") === "drawer"', 'get("surface") === "main"')).toContain(
        "side chat waits for a clear on the wrong surface"
      );
    });

    it("no check that the clear succeeded", async () => {
      expect(
        await mutate("expect((await cleared).status()).toBe(204);", "await cleared;")
      ).toContain("side chat does not check the clear succeeded");
    });

    it("no wait for an empty reply list", async () => {
      expect(
        await mutate(/\n {2}await expect\(page\.locator\("\.chatd-msg:not[^\n]*\n/, "\n")
      ).toContain("side chat does not wait for an empty reply list");
    });

    it("an unguarded screenshot", async () => {
      expect(
        await mutate(
          /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+(await page\.screenshot)/,
          "$1"
        )
      ).toContain("a screenshot ignores the capture opt-out");
    });

    it("one of the two identical no-card checks dropped", async () => {
      expect(
        await mutate(
          "      await expect(page.locator(ACTION_CARD)).toHaveCount(0);\n    }\n",
          "    }\n"
        )
      ).toContain("lost assertion: await expect(page.locator(ACTION_CARD)).toHaveCount(0);");
    });

    it("a dropped safety assertion", async () => {
      expect(await mutate("    expect(callsTo(RESET_TOOL)).toHaveLength(0);\n", "")).toContain(
        "lost assertion: expect(callsTo(RESET_TOOL)).toHaveLength(0);"
      );
    });
  });
});
