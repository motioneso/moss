// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync("apps/web/src/styles.css", "utf8");
const meetingsCss = readFileSync("packages/meetings/src/web/styles.css", "utf8");
const inputTypes = [
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "email",
  "file",
  "hidden",
  "image",
  "month",
  "number",
  "password",
  "radio",
  "range",
  "reset",
  "search",
  "submit",
  "tel",
  "text",
  "time",
  "url",
  "week"
];

function fullWidthInputRule() {
  const rule = appCss.match(
    /(input(?::where\([\s\S]*?\))?,\nselect,\ntextarea) \{\n {2}width: 100%;([\s\S]*?)\n\}/
  );
  expect(rule).not.toBeNull();
  return { selector: rule![1]!, declarations: `width: 100%;${rule![2]}`.trim() };
}

function inputWithin(type: string, meetings: boolean, radioCard: boolean) {
  const section = document.createElement("section");
  section.className = meetings ? "meeting-settings" : "other-settings";
  const label = document.createElement("label");
  if (radioCard) label.className = "jds-radio-card";
  const input = document.createElement("input");
  input.type = type;
  label.append(input);
  section.append(label);
  return input;
}

describe("Meetings CSS boundaries", () => {
  it("preserves the original global input matching outside Meetings, including radio cards", () => {
    const { selector } = fullWidthInputRule();
    for (const type of inputTypes) {
      for (const radioCard of [false, true]) {
        const input = inputWithin(type, false, radioCard);
        expect(input.matches(selector), `${type}, radio card=${radioCard}`).toBe(true);
      }
    }
  });

  it("excludes only radio-card radios inside Meetings settings", () => {
    const { selector } = fullWidthInputRule();
    for (const type of inputTypes) {
      for (const radioCard of [false, true]) {
        const input = inputWithin(type, true, radioCard);
        expect(input.matches(selector), `${type}, radio card=${radioCard}`).toBe(
          !(radioCard && type === "radio")
        );
      }
    }
  });

  it("keeps text controls, declarations and type-selector specificity unchanged", () => {
    const { selector, declarations } = fullWidthInputRule();
    // :where gives the scoped exception zero specificity; the input type remains 0-0-1.
    expect(selector).toBe(
      'input:where(:not(.meeting-settings .jds-radio-card input[type="radio"])),\nselect,\ntextarea'
    );
    for (const tagName of ["input", "select", "textarea"]) {
      expect(document.createElement(tagName).matches(selector), tagName).toBe(true);
    }
    expect(declarations).toBe(`width: 100%;
  min-height: 2.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised);
  color: var(--ink);
  padding: 0.6rem 0.7rem;`);
  });

  it("keeps fixed phone capture controls below both the navigation drawer and its scrim", () => {
    const phoneCss = meetingsCss.split("@media (max-width: 760px)")[1];
    expect(phoneCss).toBeDefined();
    const captureRule = phoneCss!.match(
      /\.meetings-capture-heading > \.jds-btn,\s*\.meetings-capture-heading > \.jds-control-pill \{([^}]+)\}/
    )?.[1];
    expect(captureRule).toContain("position: fixed;");
    const captureZ = Number(captureRule!.match(/z-index: (\d+);/)?.[1]);
    const drawerZ = Number(appCss.match(/\.sidebar \{[^{}]*z-index: (\d+);/)?.[1]);
    const scrimZ = Number(appCss.match(/\.sidebar-scrim \{[^{}]*z-index: (\d+);/)?.[1]);
    expect(captureZ).toBeGreaterThan(0);
    expect(captureZ).toBeLessThan(scrimZ);
    expect(captureZ).toBeLessThan(drawerZ);
  });
});
