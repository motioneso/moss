// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "../../packages/ui/src/tabs.js";

const styles = ["components-moss.css", "components-tabs.css"]
  .map((file) => readFileSync(`packages/ui/src/styles/${file}`, "utf8"))
  .join("\n");

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("Tabs alongside the shipped legacy navigation styles", () => {
  it("stacks its tab list and panels while preserving legacy Job Search navigation", () => {
    document.head.innerHTML = `<style>${styles}</style>`;
    document.body.innerHTML =
      renderToString(
        <Tabs
          id="review"
          ariaLabel="Review sections"
          value="notes"
          onChange={() => {}}
          items={[
            { value: "summary", label: "Summary", content: <p>Saved summary</p> },
            { value: "notes", label: "My notes", content: <textarea defaultValue="Notes" /> }
          ]}
        />
      ) +
      '<nav class="jds-tabs" aria-label="Job search view"><button class="jds-tab jds-tab--gold" aria-current="page">Matches</button></nav>';

    const tabList = document.querySelector('[role="tablist"]')!;
    expect(getComputedStyle(tabList.parentElement!).display).toBe("block");
    expect(getComputedStyle(tabList).display).toBe("flex");
    expect(getComputedStyle(document.querySelector("#review-panel-summary")!).display).toBe("none");
    expect(getComputedStyle(document.querySelector("#review-panel-notes")!).display).toBe("block");
    expect(
      getComputedStyle(document.querySelector('nav[aria-label="Job search view"]')!).display
    ).toBe("flex");
    expect(getComputedStyle(document.querySelector(".jds-tab--gold")!).borderBottomWidth).toBe(
      "3px"
    );
  });
});
