// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Badge,
  Field,
  Segmented,
  Switch,
  Avatar,
  Indicator,
  Row
} from "../../packages/settings-ui/src/index.js";
import * as Shared from "../../packages/ui/src/index.js";

describe("settings canonical adapters", () => {
  it("reuses the public primitives rather than duplicating their implementation", () => {
    expect(Segmented).toBe(Shared.Segmented);
    expect(Switch).toBe(Shared.Switch);
    expect(Avatar).toBe(Shared.Avatar);
    expect(Indicator).toBe(Shared.Indicator);
    expect(
      renderToStaticMarkup(
        <Badge tone="pine" dot>
          Ready
        </Badge>
      )
    ).toBe(
      renderToStaticMarkup(
        <Shared.Badge tone="forest" dot>
          Ready
        </Shared.Badge>
      )
    );
  });
  it("supports a real label and explicit hint/error association without cloning arbitrary children", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <Field
          label="Name"
          controlId="name"
          hint="Use your display name"
          hintId="hint"
          error="Required"
          errorId="error"
        >
          <input id="name" aria-describedby="hint error" aria-invalid="true" />
        </Field>
      )
    );
    const input = host.querySelector("input")!;
    expect(input.labels?.[0]?.textContent).toBe("Name");
    expect(input.getAttribute("aria-describedby")).toBe("hint error");
    expect(host.querySelector("#hint")?.textContent).toBe("Use your display name");
    expect(host.querySelector("#error")?.getAttribute("role")).toBe("alert");
    expect(host.querySelector("#error")?.classList.contains("jds-hint")).toBe(true);
    act(() => root.unmount());
    host.remove();
  });
  it.each(["Acme API token", "Assistant name"])(
    "keeps the existing %s label on exactly one usable control",
    (label) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      act(() =>
        root.render(
          <Field label={label}>
            <input aria-label={label} />
            {label === "Acme API token" ? <button>Save</button> : null}
          </Field>
        )
      );
      // Both aria-label and aria-labelledby are label-query targets. Naming a wrapper
      // after this same single field makes the existing user-facing label ambiguous.
      const labeled = [
        ...host.querySelectorAll<HTMLElement>("[aria-label], [aria-labelledby]")
      ].filter((node) => {
        const ids = node.getAttribute("aria-labelledby");
        const name = ids
          ? ids
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          : node.getAttribute("aria-label");
        return name === label;
      });
      const input = host.querySelector("input")!;
      expect(labeled).toEqual([input]);
      expect(input.tabIndex).toBe(0);
      input.focus();
      expect(document.activeElement).toBe(input);
      act(() => root.unmount());
      host.remove();
    }
  );
  it("keeps explicit multi-control grouping; Row accepts layout-only className", () => {
    const field = renderToStaticMarkup(
      <Field label="Actions" group>
        <button>One</button>
        <button>Two</button>
      </Field>
    );
    expect(field).toContain('role="group"');
    expect(field).toContain("aria-labelledby=");
    expect(renderToStaticMarkup(<Row name="Folder" className="set-row--stack-narrow" />)).toContain(
      'class="set-row set-row--stack-narrow"'
    );
  });
});
