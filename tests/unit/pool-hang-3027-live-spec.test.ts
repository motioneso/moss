import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = () =>
  readFile(new URL("../live/pool-hang-3027-uat.spec.ts", import.meta.url), "utf8");

describe("pool-hang-3027 live spec (#3280)", () => {
  it("starts its fresh chat through the Conversations controls", async () => {
    const text = await source();
    expect(text, "removed New chat button").not.toMatch(/name: "New chat"/);
    const opens = text.match(/name: "Open conversations"/g) ?? [];
    const sides = text.match(/name: "New side chat", exact: true/g) ?? [];
    expect(opens.length, "Open conversations clicks").toBe(1);
    expect(sides.length, "every overlay open starts a side chat").toBe(opens.length);
  });

  it("sends only after the drawer clear and an empty transcript", async () => {
    const text = await source();
    expect(text).toMatch(/url\.pathname === "\/api\/chat\/clear"/);
    expect(text).toMatch(/url\.searchParams\.get\("surface"\) === "drawer"/);
    expect(text).toMatch(/expect\(\(await cleared\)\.status\(\)\)\.toBe\(204\)/);
    expect(text, "old replies gone").toMatch(/drawer\.locator\(REPLIES\)\)\.toHaveCount\(0\)/);
    expect(text, "old steps gone").toMatch(/drawer\.locator\(ACTIVITY\)\)\.toHaveCount\(0\)/);
    const startedAt = text.indexOf("await startSideChat(page, drawer)");
    expect(startedAt, "side chat started").toBeGreaterThan(-1);
    expect(startedAt, "side chat starts before the message").toBeLessThan(
      text.indexOf('await composer.press("Enter")')
    );
  });

  it("keeps the concurrent load running across the side chat start", async () => {
    const text = await source();
    const startedAt = text.indexOf("await startSideChat(page, drawer)");
    expect(text.indexOf("const healthProbe = (async")).toBeLessThan(startedAt);
    expect(text.indexOf("const embedding = (async")).toBeLessThan(startedAt);
    expect(text.indexOf("busy = false")).toBeGreaterThan(text.indexOf("await turnResponse"));
  });
});
