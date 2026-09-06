// Slice 3: the top bar carries the trail. Proves the provider sets the trail while a page is
// mounted, clears it on unmount, and resolves the section link for a project route — through
// the same `@moss/module-web-sdk` hook a module page actually calls, so the bridge wiring is
// covered too. react-test-renderer (no DOM needed), same as module-web-sdk-ui-smoke.
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { usePageTrail } from "@moss/module-web-sdk";
import {
  PageTrailProvider,
  resolveTrailSection,
  usePageTrailDisplay
} from "../../apps/web/src/shell/page-trail.js";

function Probe() {
  const trail = usePageTrailDisplay();
  return createElement(
    "div",
    null,
    trail
      ? `${trail.sectionLabel}|${trail.sectionPath}|${trail.name}|${trail.meta ?? ""}`
      : "none"
  );
}

function Setter({ name, meta }: { readonly name: string; readonly meta?: string }) {
  usePageTrail({ name, meta });
  return null;
}

function renderTrail(path: string, setter: boolean) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          PageTrailProvider,
          null,
          createElement(Probe),
          setter
            ? createElement(Setter, { name: "Reading notes", meta: "Started Sep 5, 2026" })
            : null
        )
      )
    );
  });
  return renderer;
}

function probeText(renderer: ReactTestRenderer): string {
  return renderer.root.findByType("div").children.join("");
}

describe("page trail", () => {
  it("shows section, name and meta while the page is mounted", () => {
    const renderer = renderTrail("/workshop/abc", true);
    expect(probeText(renderer)).toBe("The Workshop|/workshop|Reading notes|Started Sep 5, 2026");
    act(() => renderer.unmount());
  });

  it("clears back to no trail when the page unmounts", () => {
    const renderer = renderTrail("/workshop/abc", true);
    expect(probeText(renderer)).not.toBe("none");
    act(() => {
      renderer.update(
        createElement(
          MemoryRouter,
          { initialEntries: ["/workshop/abc"] },
          createElement(PageTrailProvider, null, createElement(Probe))
        )
      );
    });
    expect(probeText(renderer)).toBe("none");
    act(() => renderer.unmount());
  });

  it("resolves the section link for a project route", () => {
    expect(resolveTrailSection("/workshop/abc")).toEqual({
      label: "The Workshop",
      path: "/workshop"
    });
  });

  it("does nothing when a page renders without a provider", () => {
    let renderer!: ReactTestRenderer;
    expect(() => {
      act(() => {
        renderer = create(createElement(Setter, { name: "Reading notes" }));
      });
    }).not.toThrow();
    act(() => renderer.unmount());
  });
});
