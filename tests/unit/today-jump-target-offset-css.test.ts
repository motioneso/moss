import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync("apps/web/src/styles/kit-today.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

const JUMP_TARGETS = ["start-here", "needs-you", "widgets", "goals", "news", "sports"];

function bodyForSelector(selector: string): string {
  const rules = [...css.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^}]*)\}/g)];
  const hit = rules.find((m) =>
    (m.groups?.selectors ?? "").split(",").some((s) => s.trim() === selector)
  );
  return hit?.groups?.body ?? "";
}

describe("Today jump-link targets", () => {
  it.each(JUMP_TARGETS)("#%s clears the sticky topbar when scrolled to", (id) => {
    const body = bodyForSelector(`#${id}`);
    expect(body).toMatch(/scroll-margin-top:\s*calc\(var\(--topbar-h\)\s*\+/);
  });
});
