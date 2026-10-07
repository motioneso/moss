import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appActionsUatSpec, withAppActionsUatEnvironment } from "../uat/run-app-actions-uat.js";

describe("app-actions UAT entry point", () => {
  it("selects exactly one declared spec and rejects arbitrary paths", () => {
    expect(appActionsUatSpec()).toBe("3065-app-actions.uat.spec.ts");
    expect(appActionsUatSpec("real")).toBe("3065-app-actions-real.uat.spec.ts");
    expect(() => appActionsUatSpec("../../other")).toThrow("Unknown");
  });

  it("scripted mode overrides inherited real-login configuration without reading it", async () => {
    const inherited = {
      JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE: "/private/not-read-auth.json",
      JARVIS_UAT_REAL_CHAT_CONFIGURED: "1",
      MOSS_UAT_CAPTURE_OFF: "0",
      MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF: "1",
      UNRELATED: "preserved"
    };
    let directory = "";
    expect(
      await withAppActionsUatEnvironment(
        "scripted",
        async (env) => {
          expect(env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE).not.toBe(
            inherited.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE
          );
          expect(existsSync(env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE!)).toBe(false);
          directory = dirname(env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE!);
          expect(existsSync(directory)).toBe(true);
          expect(env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("");
          expect(env.MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF).toBe("");
          expect(env.MOSS_UAT_CAPTURE_OFF).toBe("1");
          expect(env.UNRELATED).toBe("preserved");
          return 7;
        },
        inherited
      )
    ).toBe(7);
    expect(existsSync(directory)).toBe(false);
    expect(inherited.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  });

  it("cleans its own temporary directory after a child failure", async () => {
    let directory = "";
    await expect(
      withAppActionsUatEnvironment(
        "scripted",
        async (env) => {
          directory = dirname(env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE!);
          throw new Error("fixture failed");
        },
        {}
      )
    ).rejects.toThrow("fixture failed");
    expect(existsSync(directory)).toBe(false);
  });

  it.each([undefined, "", "true", "0"])(
    "refuses real mode before provisioning when readiness is %s",
    async (flag) => {
      const run = vi.fn(async () => 0);
      await expect(
        withAppActionsUatEnvironment("real", run, {
          ...(flag === undefined ? {} : { JARVIS_UAT_REAL_CHAT_CONFIGURED: flag })
        })
      ).rejects.toThrow("Real app-actions proof was not run");
      expect(run).not.toHaveBeenCalled();
    }
  );

  it("passes explicit owner opt-in through without installing or inspecting credentials itself", async () => {
    const run = vi.fn(async (env: NodeJS.ProcessEnv) => {
      expect(env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
      expect(env.MOSS_UAT_CAPTURE_OFF).toBe("1");
      expect(env.MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF).toBe("1");
      return 0;
    });
    expect(
      await withAppActionsUatEnvironment("real", run, { JARVIS_UAT_REAL_CHAT_CONFIGURED: "1" })
    ).toBe(0);
    expect(run).toHaveBeenCalledOnce();
  });
});
