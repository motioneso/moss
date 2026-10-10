import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

describe("usable page viewport", () => {
  it("keeps boot and app body minima within the scrollbar-reduced viewport", () => {
    for (const path of ["apps/web/src/styles/boot.css", "apps/web/src/styles.css"]) {
      const css = readFileSync(join(root, path), "utf8");
      const bodyRule = css.match(/(?:^|\n)body\s*\{([^}]*)\}/)?.[1];
      expect(bodyRule, path).toContain("min-width: min(320px, 100%)");
      expect(bodyRule, path).not.toMatch(/overflow(?:-x)?:\s*(?:hidden|clip)/);
    }
  });
});
