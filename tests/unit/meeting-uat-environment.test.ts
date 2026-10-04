import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { withMeetingUatEnvironment } from "../uat/run-meetings-uat.js";

describe("credential-free meeting draft UAT", () => {
  it("overrides inherited real-chat auth with an absent private temporary path and cleans up", async () => {
    const original = {
      JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE: "/never-read-host-login",
      PATH: "test-path"
    };
    let path = "";
    expect(
      await withMeetingUatEnvironment(async (env) => {
        path = env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE!;
        expect(path).not.toBe(original.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE);
        expect(env.PATH).toBe("test-path");
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
