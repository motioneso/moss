// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const css = read("apps/web/src/styles/workspace-layout.css");
const areaSelector =
  ".workspace-area:has(.content-surface:not([hidden]) > .workshop-page--conversation)";
const bodySelector =
  ".workspace-body:has(> .content-surface:not([hidden]) > .workshop-page--conversation)";
const contentSelector = ".content-surface:not([hidden]):has(> .workshop-page--conversation)";
function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
}
function fixture() {
  document.body.innerHTML =
    '<div class="app-frame"><div class="workspace-area"><header class="topbar">Wrapped header</header><div class="workspace-body"><main class="content-surface"><div class="workshop-page workshop-page--conversation"></div></main></div></div></div>';
  return {
    area: document.querySelector<HTMLElement>(".workspace-area")!,
    body: document.querySelector<HTMLElement>(".workspace-body")!,
    content: document.querySelector<HTMLElement>(".content-surface")!,
    page: document.querySelector<HTMLElement>(".workshop-page")!
  };
}
afterEach(() => document.body.replaceChildren());

describe("bounded conversation workspace layout", () => {
  it("opts in only a visible direct-child conversation, including docked chat", () => {
    const { area, body, content, page } = fixture();
    expect(area.matches(areaSelector)).toBe(true);
    expect(body.matches(bodySelector)).toBe(true);
    expect(content.matches(contentSelector)).toBe(true);
    body.classList.add("workspace-body--docked");
    expect(body.matches(bodySelector)).toBe(true);
    page.classList.remove("workshop-page--conversation");
    expect(area.matches(areaSelector)).toBe(false);
    expect(body.matches(bodySelector)).toBe(false);
    expect(content.matches(contentSelector)).toBe(false);
  });
  it("releases the opt-in for hidden expanded content and restores it when returning", () => {
    const { area, body, content } = fixture();
    body.classList.add("workspace-body--expanded");
    content.hidden = true;
    expect(area.matches(areaSelector)).toBe(false);
    expect(body.matches(bodySelector)).toBe(false);
    expect(content.matches(contentSelector)).toBe(false);
    content.hidden = false;
    body.classList.remove("workspace-body--expanded");
    expect(area.matches(areaSelector)).toBe(true);
  });
  it("uses the actual auto-sized header track rather than subtracting its nominal height", () => {
    expect(rule(areaSelector)).toContain("height: 100dvh");
    expect(rule(areaSelector)).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(rule(areaSelector)).not.toContain("--topbar-h");
    for (const selector of [bodySelector, contentSelector]) {
      expect(rule(selector)).toContain("height: 100%");
      expect(rule(selector)).toContain("min-height: 0");
    }
    expect(rule(contentSelector)).toContain("box-sizing: border-box");
  });
  it("preserves existing docked/expanded and desktop/phone padding outside the opt-in", () => {
    expect(rule(".workspace-area")).toContain("grid-template-rows: auto 1fr");
    expect(rule(".workspace-body--docked")).toContain("height: calc(100dvh - var(--topbar-h))");
    expect(rule(".workspace-body--expanded")).toContain("height: 100dvh");
    expect(css).toContain(".workspace-body--expanded .content-surface[hidden]");
    expect(css).toContain("@media (min-width: 721px)");
    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain("padding: var(--space-7) var(--space-6)");
    expect(css).toContain("padding: 0.75rem");
  });
  it("loads the extracted layout once after the legacy base and before later shell overrides", () => {
    const index = read("apps/web/src/styles/index.css");
    const imports = index.match(/@import\s+"[^"]+";/g)!;
    expect(imports.indexOf('@import "./workspace-layout.css";')).toBe(
      imports.indexOf('@import "../styles.css";') + 1
    );
    expect(imports.indexOf('@import "./workspace-layout.css";')).toBeLessThan(
      imports.indexOf('@import "./kit-shell-rename.css";')
    );
    expect(read("apps/web/src/styles.css")).not.toMatch(
      /\.workspace-(?:area|body)[\s:{-]|\.content-surface[\s:{]/
    );
  });
});
