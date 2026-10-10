import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { shouldBindCheapestModel } from "../live/live-chat-model.js";
import { REAL_CHAT_CONFIGURED_ENV } from "../uat/real-chat-env.js";

const source = () =>
  readFile(new URL("../live/integrations-2162-uat.spec.ts", import.meta.url), "utf8");

describe("integrations live spec (#3279)", () => {
  it("starts the chat proof through Conversations > New side chat", async () => {
    const text = await source();
    expect(text, "removed New chat button").not.toMatch(/name: \/\^New chat\$\/|name: "New chat"/);
    const opens = text.match(/name: "Open conversations"/g) ?? [];
    const sides = text.match(/name: "New side chat", exact: true/g) ?? [];
    expect(opens.length, "Open conversations clicks").toBeGreaterThan(0);
    expect(sides.length, "every overlay open starts a side chat").toBe(opens.length);
  });

  it("waits for the drawer clear and an empty transcript before sending", async () => {
    const text = await source();
    expect(text, "drawer clear wait").toMatch(/url\.pathname === "\/api\/chat\/clear"/);
    expect(text, "clear acknowledged").toMatch(
      /expect\(\(await cleared\)\.status\(\)\)\.toBe\(204\)/
    );
    expect(text, "empty transcript").toMatch(/locator\("\.chatd-msg"\)\)\.toHaveCount\(0\)/);
  });

  it("fails rather than skips when a service or credential is missing", async () => {
    const text = await source();
    expect(text, "a missing prerequisite must not skip green").not.toMatch(/\.(skip|fixme)\(/);
    expect(text, "Home Assistant test requires its service").toMatch(
      /async \(\{ page \}\) => \{\s*requireEnv\(\{ LIVE_HA_MCP_URL: HA_MCP_URL, LIVE_HA_TOKEN: HA_TOKEN \}\);/
    );
    expect(text, "Radarr test requires its service").toMatch(
      /\}\) => \{\s*requireEnv\(\{\s*LIVE_RADARR_URL: RADARR_URL,\s*LIVE_RADARR_KEY: RADARR_KEY,\s*LIVE_RADARR_SPEC_FILE: RADARR_SPEC_FILE\s*\}\);/
    );
  });

  it("checks credentials without echoing them into a failure report", async () => {
    const text = await source();
    expect(text, "toContain prints the credential on failure").not.toMatch(
      /toContain\((HA_TOKEN|RADARR_KEY)\)/
    );
    expect(text.match(/expectCredentialAbsent\(page, HA_TOKEN\)/g)?.length ?? 0).toBe(1);
    expect(text.match(/expectCredentialAbsent\(page, RADARR_KEY\)/g)?.length ?? 0).toBe(2);
  });
});

describe("live chat model binding (#3279)", () => {
  it("binds only when asked", () => {
    expect(shouldBindCheapestModel({})).toBe(false);
    expect(
      shouldBindCheapestModel({ LIVE_BIND_CHEAPEST_MODEL: "1", [REAL_CHAT_CONFIGURED_ENV]: "1" })
    ).toBe(true);
  });

  it("refuses to bind without a copied Codex sign-in", () => {
    expect(() => shouldBindCheapestModel({ LIVE_BIND_CHEAPEST_MODEL: "1" })).toThrow(
      /refusing to fake the model/
    );
  });
});
