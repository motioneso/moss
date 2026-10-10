import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
    expect(text, "a missing prerequisite must not skip green").not.toMatch(/test\.skip\(/);
  });
});
