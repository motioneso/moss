import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeSignInPaths,
  signInClaudeThroughMoss,
  type ClaudeSignInPaths
} from "./claude-signin-handoff.js";

const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
const CODE = "one-time-code#state";

interface Call {
  readonly path: string;
  readonly data: Record<string, string>;
}

/** A scripted Moss: each path answers from its own queue, repeating its last answer. */
function fakeMoss(script: Record<string, readonly object[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(script).map(([path, list]) => [path, [...list]]));
  return {
    calls,
    api: {
      post: async (path: string, data: Record<string, string>) => {
        calls.push({ path, data });
        const queue = queues.get(path) ?? [{}];
        return queue.length > 1 ? queue.shift() : queue[0];
      }
    }
  };
}

describe("signInClaudeThroughMoss (#3361)", () => {
  let dir: string;
  let paths: ClaudeSignInPaths;
  let clock: number;
  const logs: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uat-claude-signin-"));
    process.env.JARVIS_UAT_CLAUDE_SIGNIN_DIR = join(dir, "handoff");
    paths = claudeSignInPaths("uat-test");
    clock = 0;
    logs.length = 0;
  });

  afterEach(() => {
    delete process.env.JARVIS_UAT_CLAUDE_SIGNIN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (onSleep: () => void = () => undefined, codeWaitMs = 30_000) => ({
    paths,
    codeWaitMs,
    now: () => clock,
    log: (line: string) => logs.push(line),
    sleep: async (ms: number) => {
      clock += ms;
      onSleep();
    }
  });

  it("publishes the link privately, submits the operator's code once, and settles ready", async () => {
    const moss = fakeMoss({
      "/api/onboarding/provider-login/begin": [{ loginId: "L1", status: "awaiting_authorization" }],
      "/api/onboarding/provider-login/poll": [
        { loginId: "L1", status: "awaiting_token", authorizationUrl: LINK },
        { loginId: "L1", status: "ready" }
      ],
      "/api/onboarding/provider-login/submit-token": [{ loginId: "L1", status: "awaiting_token" }]
    });
    let seenLink = "";
    let linkMode = 0;
    const answer = () => {
      if (!seenLink && existsSync(paths.linkFile)) {
        seenLink = readFileSync(paths.linkFile, "utf8").trim();
        linkMode = statSync(paths.linkFile).mode & 0o777;
        writeFileSync(paths.codeFile, `${CODE}\n`);
      }
    };

    await signInClaudeThroughMoss(moss.api, options(answer));

    expect(seenLink).toBe(LINK);
    expect(linkMode).toBe(0o600);
    expect(statSync(join(paths.linkFile, "..")).mode & 0o777).toBe(0o700);
    const submits = moss.calls.filter((c) => c.path.endsWith("/submit-token"));
    expect(submits).toEqual([
      {
        path: "/api/onboarding/provider-login/submit-token",
        data: { providerKind: "anthropic", loginId: "L1", token: CODE }
      }
    ]);
    expect(moss.calls.every((c) => c.data.providerKind === "anthropic")).toBe(true);
    expect(moss.calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
    expect(existsSync(paths.linkFile)).toBe(false);
    expect(existsSync(paths.codeFile)).toBe(false);
    expect(logs.join("\n")).not.toContain(CODE);
    expect(logs.join("\n")).not.toContain(LINK);
  });

  it("returns at once when Moss is already signed in to Claude", async () => {
    const moss = fakeMoss({
      "/api/onboarding/provider-login/begin": [{ loginId: "L1", status: "ready" }]
    });
    await signInClaudeThroughMoss(moss.api, options());
    expect(moss.calls).toHaveLength(1);
    expect(existsSync(paths.linkFile)).toBe(false);
  });

  it("gives up when no code arrives before the link expires, and cancels the login", async () => {
    const moss = fakeMoss({
      "/api/onboarding/provider-login/begin": [
        { loginId: "L1", status: "awaiting_token", authorizationUrl: LINK }
      ]
    });
    await expect(signInClaudeThroughMoss(moss.api, options())).rejects.toThrow(
      /no Claude sign-in code within 30000ms/
    );
    expect(moss.calls.at(-1)).toEqual({
      path: "/api/onboarding/provider-login/cancel",
      data: { providerKind: "anthropic", loginId: "L1" }
    });
    expect(moss.calls.some((c) => c.path.endsWith("/submit-token"))).toBe(false);
    expect(existsSync(paths.linkFile)).toBe(false);
  });

  it("fails loudly when Moss rejects the code", async () => {
    const moss = fakeMoss({
      "/api/onboarding/provider-login/begin": [
        { loginId: "L1", status: "awaiting_token", authorizationUrl: LINK }
      ],
      "/api/onboarding/provider-login/submit-token": [
        { loginId: "L1", status: "error", message: "login failed" }
      ]
    });
    const answer = () => {
      if (existsSync(paths.linkFile)) writeFileSync(paths.codeFile, CODE);
    };
    await expect(signInClaudeThroughMoss(moss.api, options(answer))).rejects.toThrow(
      /Claude sign-in submit ended "error": login failed/
    );
    expect(moss.calls.at(-1)?.path).toBe("/api/onboarding/provider-login/cancel");
    expect(existsSync(paths.codeFile)).toBe(false);
  });
});
