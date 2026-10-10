// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ButtonLink, buttonLinkClassName } from "../../packages/ui/src/button-link.js";
import { RadioCardGroup } from "../../packages/ui/src/radio-card-group.js";
import { PeekCloseButton } from "../../packages/ui/src/peek-close-button.js";
import { WeatherChip } from "../../packages/ui/src/weather-chip.js";

describe("shared accessible controls", () => {
  it("supports semantic anchor text actions and a router-compatible class helper", () => {
    const html = renderToStaticMarkup(
      <ButtonLink variant="link" href="/settings">
        Settings
      </ButtonLink>
    );
    expect(html).toContain('<a href="/settings"');
    expect(html).toContain('class="jds-btn jds-btn--link"');
    expect(buttonLinkClassName("link")).toBe("jds-btn jds-btn--link");
  });
  it("disables all radio options while pending and allows independently disabled choices", () => {
    const all = renderToStaticMarkup(
      <RadioCardGroup
        name="mode"
        ariaLabel="Mode"
        value="one"
        disabled
        options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two" }
        ]}
        onChange={vi.fn()}
      />
    );
    expect(all.match(/disabled=""/g)).toHaveLength(2);
    expect(all).toContain('aria-disabled="true"');
    const one = renderToStaticMarkup(
      <RadioCardGroup
        name="mode"
        ariaLabel="Mode"
        value="one"
        options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two", disabled: true }
        ]}
        onChange={vi.fn()}
      />
    );
    expect(one.match(/disabled=""/g)).toHaveLength(1);
  });
  it("gives a default accessible name to icon-only peek close controls", () => {
    expect(renderToStaticMarkup(<PeekCloseButton>×</PeekCloseButton>)).toContain(
      'aria-label="Close details"'
    );
    expect(
      renderToStaticMarkup(<PeekCloseButton aria-label="Close event">×</PeekCloseButton>)
    ).toContain('aria-label="Close event"');
  });
  it("associates weather detail on focus and dismisses it on Escape", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <WeatherChip
          href="/weather"
          location="Home"
          days={[{ label: "Today", icon: "sun", temp: "20°", detail: "Clear skies" }]}
        />
      )
    );
    const link = host.querySelector("a")!;
    act(() => link.focus());
    const tip = host.querySelector('[role="tooltip"]')!;
    expect(link.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.textContent).toBe("Clear skies");
    act(() => link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(link.hasAttribute("aria-describedby")).toBe(false);
    act(() => root.unmount());
    host.remove();
  });
});

describe("canonical checkbox native states", () => {
  const checkboxCss = [
    "../../packages/ui/src/styles/components-forms.css",
    "../../apps/web/src/styles/components-forms.css"
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");

  it.each([false, true])(
    "shows a mixed dash when checked=%s, including while disabled",
    (checked) => {
      const style = document.createElement("style");
      style.textContent = checkboxCss;
      const label = document.createElement("label");
      label.className = "jds-check";
      label.innerHTML =
        '<input type="checkbox" aria-label="All Football leagues"><span class="jds-check__box" aria-hidden="true"><svg></svg></span>';
      document.head.append(style);
      document.body.append(label);
      try {
        const input = label.querySelector("input")!;
        const box = label.querySelector<HTMLElement>(".jds-check__box")!;
        const check = box.querySelector("svg")!;
        input.checked = checked;
        input.indeterminate = true;
        const marker = Array.from(style.sheet!.cssRules).find(
          (rule) =>
            rule instanceof CSSStyleRule &&
            rule.selectorText.includes(":indeterminate") &&
            rule.selectorText.endsWith("::after")
        ) as CSSStyleRule | undefined;
        expect(marker).toBeDefined();
        expect(box.matches(marker!.selectorText.replace("::after", ""))).toBe(true);
        expect(marker!.style.content).toBe('""');
        expect(marker!.style.width).toBe("var(--space-2)");
        expect(marker!.style.height).toBe("var(--border-w-strong)");
        expect(marker!.style.background).toBe("currentcolor");
        // The shared skin precedes the host layout CSS. Mixed must still hide the
        // checked SVG when both native state properties are true.
        expect(getComputedStyle(check).opacity).toBe("0");
        input.disabled = true;
        input.click();
        expect(input.checked).toBe(checked);
        expect(input.indeterminate).toBe(true);
        expect(box.matches(marker!.selectorText.replace("::after", ""))).toBe(true);
        expect(getComputedStyle(box).opacity).toBe("0.5");
        input.disabled = false;
        input.click();
        expect(input.checked).toBe(!checked);
        expect(input.indeterminate).toBe(false);
        expect(box.matches(marker!.selectorText.replace("::after", ""))).toBe(false);
        expect(getComputedStyle(check).opacity).toBe(checked ? "0" : "1");
        expect(input.getAttribute("aria-label")).toBe("All Football leagues");
      } finally {
        label.remove();
        style.remove();
      }
    }
  );
});
