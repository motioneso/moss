import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("tests/uat/visual-parity/shell-navigation.ts", "utf8");
const reloadBlock = source.slice(source.indexOf("await persisted.reload();"));

describe("P1 navigation reload readiness", () => {
  it("waits for the mounted rail before measuring and reports stored state", () => {
    const ready = reloadBlock.indexOf('await expectAttr(persisted, "rail");');
    const measured = reloadBlock.indexOf(
      "const persistedGeometry = await shellGeometry(persisted);"
    );
    const stored = reloadBlock.indexOf('localStorage.getItem("jarvis.nav:v1")');

    expect(ready).toBeGreaterThan(-1);
    expect(measured).toBeGreaterThan(ready);
    expect(stored).toBeGreaterThan(measured);
    expect(reloadBlock).toContain("persistedGeometry.navMode");
    expect(reloadBlock).toContain("persistedStorage");
  });
});
