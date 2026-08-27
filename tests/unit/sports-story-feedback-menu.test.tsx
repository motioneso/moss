// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoryFeedbackMenu } from "../../packages/sports/src/web/story-feedback-menu.js";

async function renderMenu(
  storyRef: string | undefined = "story-ref-1",
  onChanged = vi.fn()
): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(StoryFeedbackMenu, { storyRef, surface: "sports", onChanged })
      )
    );
  });
  return renderer;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "props" in value) {
    return text((value as { props: { children?: unknown } }).props.children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find(
    (item) => item.props["aria-label"] === label || text(item.props.children) === label
  )!;
}

describe("Sports story feedback menu", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not render for a cached story without an opaque reference", async () => {
    expect((await renderMenu("")).toJSON()).toBeNull();
  });

  it("opens both actions and refuses a blank less-like reason", async () => {
    const renderer = await renderMenu();
    await act(async () => button(renderer, "Story feedback").props.onClick());
    expect(button(renderer, "More like this")).toBeTruthy();
    expect(button(renderer, "Less like this")).toBeTruthy();

    await act(async () => button(renderer, "Less like this").props.onClick());
    const save = button(renderer, "Save");
    await act(async () => save.props.onClick());
    expect(renderer.root.findByProps({ role: "alert" }).props.children).toBe(
      "Tell us why before saving."
    );
  });

  it("trims a valid reason, sends the shared fields, and reports success", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ feedback: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const renderer = await renderMenu("story-ref-2", onChanged);

    await act(async () => button(renderer, "Story feedback").props.onClick());
    await act(async () => button(renderer, "Less like this").props.onClick());
    const reason = renderer.root.findByType("textarea");
    await act(async () => reason.props.onChange({ currentTarget: { value: "  Not useful  " } }));
    await act(async () => {
      button(renderer, "Save").props.onClick();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/usefulness-feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          targetKind: "sports_story",
          targetRef: "story-ref-2",
          surface: "sports",
          kind: "less_like_this",
          reason: "Not useful"
        })
      })
    );
    expect(onChanged).toHaveBeenCalledWith("story-ref-2", "less_like_this");
    expect(renderer.root.findByProps({ role: "status" }).props.children).toBe("Saved");
  });
});
