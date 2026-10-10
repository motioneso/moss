import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEETING_UAT_GROUPS,
  meetingUatSpecs,
  withMeetingUatEnvironment
} from "../uat/run-meetings-uat.js";

describe("credential-free meeting draft UAT", () => {
  it("overrides inherited real-chat auth with an absent private temporary path and cleans up", async () => {
    const original = {
      JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE: "/never-read-host-login",
      PATH: "test-path",
      JARVIS_UAT_REAL_CHAT_CONFIGURED: "1",
      MOSS_UAT_CAPTURE_OFF: "0"
    };
    let path = "";
    expect(
      await withMeetingUatEnvironment(async (env) => {
        path = env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE!;
        expect(path).not.toBe(original.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE);
        expect(env.PATH).toBe("test-path");
        expect(env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("");
        expect(env.MOSS_UAT_CAPTURE_OFF).toBe("1");
        await expect(access(dirname(path))).resolves.toBeUndefined();
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
        return 7;
      }, original)
    ).toBe(7);
    expect(original.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE).toBe("/never-read-host-login");
    await expect(access(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("also removes its directory when the runner fails", async () => {
    let path = "";
    await expect(
      withMeetingUatEnvironment(async (env) => {
        path = env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE!;
        throw new Error("runner failure");
      }, {})
    ).rejects.toThrow("runner failure");
    await expect(access(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("bounded credential-free UAT group selection", () => {
  it("keeps the six bounded Meetings specs by default", () => {
    expect(meetingUatSpecs()).toEqual([
      "2981-meeting-drafts.uat.spec.ts",
      "2981-meeting-chat.uat.spec.ts",
      "2981-meeting-outputs.uat.spec.ts",
      "2981-meeting-history.uat.spec.ts",
      "2981-meeting-capture.uat.spec.ts",
      "2981-meeting-automatic-summary.uat.spec.ts"
    ]);
  });
  it("selects only fixed groups and never includes real-provider conditional specs", () => {
    expect(Object.keys(MEETING_UAT_GROUPS)).toEqual([
      "meetings",
      "chat",
      "runtime",
      "model-fixtures"
    ]);
    const specs = Object.keys(MEETING_UAT_GROUPS).flatMap((group) => [...meetingUatSpecs(group)]);
    expect(specs).toHaveLength(20);
    expect(new Set(specs).size).toBe(20);
    expect(specs).toContain("2956-activity-history.uat.spec.ts");
    expect(specs).not.toContain("2889-model-activity-log.uat.spec.ts");
    for (const spec of [
      "1909-sports-public-source-completion",
      "notes-default-retrieval",
      "notes-path-recheck",
      "workshop-chat-handover"
    ])
      expect(specs).not.toContain(`${spec}.uat.spec.ts`);
  });
  it.each([
    "",
    "all",
    "chat ",
    "../notes-default-retrieval.uat.spec.ts",
    "constructor",
    "__proto__"
  ])("rejects unknown group %j before starting a runner", (group) => {
    expect(() => meetingUatSpecs(group)).toThrow("Unknown credential-free Meetings UAT group");
  });
});

describe("credential-free UAT capture settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("disables trace/screenshots/video when requested by the wrapper", async () => {
    vi.stubEnv("JARVIS_UAT_BASE_URL", "http://fixture.invalid");
    vi.stubEnv("MOSS_UAT_CAPTURE_OFF", "1");
    vi.resetModules();
    const { default: config } = await import("../uat/playwright.uat.config.js");
    expect(config.use).toMatchObject({ trace: "off", screenshot: "off", video: "off" });
  });
  it("preserves other UAT callers' trace default", async () => {
    vi.stubEnv("JARVIS_UAT_BASE_URL", "http://fixture.invalid");
    vi.stubEnv("MOSS_UAT_CAPTURE_OFF", "0");
    vi.resetModules();
    const { default: config } = await import("../uat/playwright.uat.config.js");
    expect(config.use?.trace).toBe("retain-on-failure");
  });
});

it("guards every direct screenshot in the credential-free allowlist with its capture opt-out", async () => {
  let captures = 0;
  for (const spec of Object.keys(MEETING_UAT_GROUPS).flatMap((group) => [
    ...meetingUatSpecs(group)
  ])) {
    const source = await readFile(new URL(`../uat/specs/${spec}`, import.meta.url), "utf8");
    const direct = source.match(/\bpage\.screenshot\(/g) ?? [];
    const guarded =
      source.match(
        /if \(process\.env\.MOSS_UAT_CAPTURE_OFF !== "1"\)\s+await page\.screenshot\(/g
      ) ?? [];
    expect(direct.length, `${spec}: unguarded diagnostic screenshots`).toBe(guarded.length);
    captures += direct.length;
  }
  expect(captures).toBe(1); // Existing shadow-report diagnostic; no new capture added.
});
