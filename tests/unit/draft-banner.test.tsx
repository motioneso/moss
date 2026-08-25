// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { DraftBanner, type DraftBannerProps } from "../../apps/web/src/chat/draft-banner.js";

// react-test-renderer has no textContent; walk the JSON tree and join every string leaf.
function renderedText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "object" && "children" in (node as Record<string, unknown>)) {
    return renderedText((node as { children: unknown }).children);
  }
  return "";
}

function renderBanner(props: DraftBannerProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(DraftBanner, props));
  });
  return renderer;
}

const baseProps: DraftBannerProps = {
  moduleId: "mod_123",
  whatItReaches: "YouTube",
  whatItKeeps: "nothing",
  restartRequired: "You keep seeing it either way; everyone else sees it after the next restart.",
  onShip: () => {},
  onAskForChange: () => {},
  onSeeCode: () => {},
  onThrowAway: () => {}
};

describe("DraftBanner", () => {
  it("shows what it reaches, what it keeps, and the restart cost", () => {
    const renderer = renderBanner(baseProps);
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("YouTube");
    expect(text).toContain("nothing");
    expect(text).toContain(baseProps.restartRequired);
  });

  it("calls each action from its own button", () => {
    const onShip = vi.fn();
    const onAskForChange = vi.fn();
    const onSeeCode = vi.fn();
    const onThrowAway = vi.fn();
    const renderer = renderBanner({ ...baseProps, onShip, onAskForChange, onSeeCode, onThrowAway });

    const findButton = (label: string) =>
      renderer.root.findAllByType("button").find((instance) => instance.children.includes(label));

    const shipButton = findButton("Ship it");
    const askButton = findButton("Ask for a change");
    const codeButton = findButton("See the code");
    const throwButton = findButton("Throw it away");
    if (!shipButton || !askButton || !codeButton || !throwButton) {
      throw new Error("DraftBanner action buttons not found");
    }

    act(() => shipButton.props.onClick());
    expect(onShip).toHaveBeenCalledOnce();

    act(() => askButton.props.onClick());
    expect(onAskForChange).toHaveBeenCalledOnce();

    act(() => codeButton.props.onClick());
    expect(onSeeCode).toHaveBeenCalledOnce();

    act(() => throwButton.props.onClick());
    expect(onThrowAway).toHaveBeenCalledOnce();
  });

  // #1890: the throw-away button is live now. It only greys out while a delete is in flight,
  // and the old "not wired up yet" tooltip must not come back when the action is supplied.
  it("enables the throw-away button and shows no tooltip once the action exists", () => {
    const renderer = renderBanner({
      ...baseProps,
      throwAwayUnavailableReason: "should never be shown"
    });
    const throwButton = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Throw it away"));
    expect(throwButton?.props.disabled).toBe(false);
    expect(throwButton?.props.title).toBeUndefined();
  });

  it("greys out the throw-away button while a delete is in flight", () => {
    const onThrowAway = vi.fn();
    const renderer = renderBanner({ ...baseProps, onThrowAway, throwAwayPending: true });
    const throwButton = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Throw it away"));
    expect(throwButton?.props.disabled).toBe(true);
  });

  it("greys out the throw-away button and explains why when there is no action", () => {
    const renderer = renderBanner({
      ...baseProps,
      onThrowAway: undefined,
      throwAwayUnavailableReason: "Not available here."
    });
    const throwButton = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Throw it away"));
    expect(throwButton?.props.disabled).toBe(true);
    expect(throwButton?.props.title).toBe("Not available here.");
  });
});
