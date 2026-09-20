import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles/components-moss-today.css", "utf8");
const kit = readFileSync("apps/web/src/styles/kit-today.css", "utf8");
const desks = readFileSync("apps/web/src/styles/kit-today-desks.css", "utf8");
const sidelines = readFileSync("packages/sports/src/web/styles/sports-7-sidelines.css", "utf8");

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

describe("Today sports section row pin", () => {
  const MEDIA = "@media (min-width: 1081px)";

  function ruleBodiesInMedia(css: string, media: string): string[] {
    const bodies: string[] = [];
    let i = 0;
    for (;;) {
      const m = css.indexOf(media, i);
      if (m === -1) break;
      const open = css.indexOf("{", m);
      let depth = 1;
      let j = open + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      const inner = css.slice(open + 1, j - 1);
      for (const rm of inner.matchAll(/\.cmd-grid\s*>\s*\.jds-brief--sports\s*\{([^}]*)\}/g))
        if (rm[1] !== undefined) bodies.push(rm[1]);
      i = j;
    }
    return bodies;
  }

  function stripMedia(css: string): string {
    let out = "";
    let i = 0;
    for (;;) {
      const m = css.indexOf("@media", i);
      if (m === -1) {
        out += css.slice(i);
        break;
      }
      out += css.slice(i, m);
      const open = css.indexOf("{", m);
      let depth = 1;
      let j = open + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      i = j;
    }
    return out;
  }

  it("pins the sports section to row 2 on desktop only", () => {
    const desktop = ruleBodiesInMedia(desks, MEDIA);
    expect(desktop.some((b) => /grid-row:\s*2/.test(b))).toBe(true);
    const top = stripMedia(desks);
    const plain = [...top.matchAll(/\.cmd-grid\s*>\s*\.jds-brief--sports\s*\{([^}]*)\}/g)];
    expect(plain.length).toBeGreaterThan(0);
    for (const rm of plain) expect(rm[1]).not.toMatch(/grid-row/);
  });
});

describe("Today sports phone rule gap", () => {
  it("holds the phone scores row 4px closer for the 148px Last-night rule target", () => {
    expect(sidelines).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.jds-brief--sports \.desk-scores\s*\{[^}]*padding-top:\s*18px/
    );
    expect(sidelines).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.jds-brief--sports \.desk-stories\s*\{[^}]*padding-top:\s*22px/
    );
  });
});
