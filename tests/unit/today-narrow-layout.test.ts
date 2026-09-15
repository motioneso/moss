import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles/components-moss-today.css", "utf8");
const kit = readFileSync("apps/web/src/styles/kit-today.css", "utf8");

describe("Today narrow masthead", () => {
  it("stacks masthead content instead of squeezing lead copy beside the folio", () => {
    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.jds-masthead__row\s*\{[\s\S]*?flex-direction:\s*column;/
    );
  });
});

describe("Today grid order", () => {
  it("collapses the two-column grid to one column on narrow screens", () => {
    expect(kit).toMatch(
      /@media \(max-width: 1080px\)[\s\S]*?\.cmd-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;/
    );
  });

  it("lets schedule rows shrink instead of pushing past narrow viewports", () => {
    expect(kit).toMatch(/\.day-ev\s*\{[^}]*grid-template-columns:[^;]*minmax\(0,\s*1fr\)/);
  });

  it("keeps the desktop two-column look through explicit placement, not order", () => {
    expect(kit).toMatch(/\.cmd-main\s*\{[^}]*grid-column:\s*1/);
    expect(kit).toMatch(/\.cmd-aside\s*\{[^}]*grid-column:\s*2/);
    expect(kit).not.toMatch(/^\s*order\s*:/m);
  });
});

describe("Today populated 320px offenders", () => {
  it("lets the sports card grid yield its 300px floor inside narrow Today columns", () => {
    expect(kit).toMatch(/\.cmd-main\s+\.sp-tkgrid\s*\{[^}]*minmax\(min\(300px,\s*100%\),\s*1fr\)/);
    expect(kit).toMatch(/\.cmd-main\s+\.sp-tkgrid\s*>\s*\*\s*\{[^}]*min-width:\s*0/);
  });

  it("keeps the weather strip and its place name inside the page", () => {
    expect(styles).toMatch(/\.jds-weather-chip-wrapper\s*\{[^}]*max-width:\s*100%/);
    expect(styles).toMatch(/\.jds-weather-chip__location\s*\{[^}]*text-overflow:\s*ellipsis/);
  });
});
