import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync("apps/web/src/styles/settings.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{(?<body>[^}]*)\\}`, "m"));
  return match?.groups?.body ?? "";
}

describe("time zone field width (#boot-settings-polish)", () => {
  it("caps the time zone picker at the same width as the Language and Date format fields beside it", () => {
    // The time zone field is a Combobox (.jds-combobox); Language and Date format are native
    // Select fields (.jds-selectwrap). All three sit in a .fld__row, so they must share one
    // sizing rule or the picker renders far wider than its neighbors.
    const sizing = rule(".fld__row > .jds-combobox");
    expect(sizing).toContain("flex: 0 1 340px");
    expect(sizing).toContain("min-width: 200px");
    expect(rule(".fld__row > .jds-selectwrap")).toBe(sizing);
  });
});
