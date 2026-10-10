// @vitest-environment jsdom
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
