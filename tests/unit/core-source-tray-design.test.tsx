// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@moss/ui";
import type { AnswerSourceSupportCard } from "@moss/shared";
import { SourceChips, stripDisplayMarkers } from "../../apps/web/src/chat/answer-provenance.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";

vi.mock("../../apps/web/src/chat/meeting-source-link.js", () => ({
  MeetingSourceLink: ({
    card,
    messageId
  }: {
    card: AnswerSourceSupportCard;
    messageId?: string;
  }) => <button data-meeting-message={messageId}>{card.sourceLabel}</button>
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const card: AnswerSourceSupportCard = {
  supportId: "S1",
  sourceKind: "note",
  sourceLabel: "Project note",
  title: "Launch plan",
  snippet: "A fictional plan excerpt.",
  state: "confirmed_source",
  canDereference: false
};
let root: Root | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

async function mount(content: ReactNode = <SourceChips cards={[card]} />) {
  const container = document.createElement("div");
  document.body.append(container);
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "12" }
  });
  root = createRoot(container);
  await act(async () =>
    root!.render(<QueryClientProvider client={client!}>{content}</QueryClientProvider>)
  );
  return container;
}

async function open(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
  trigger.focus();
  await act(async () => trigger.click());
  return trigger;
}

describe("nonmodal source disclosure", () => {
  it("has a named controls target, focuses Close, and restores the opener on Escape", async () => {
    const container = await mount();
    const trigger = await open(container);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Source: Launch plan");
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(trigger.getAttribute("role")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close source");
    expect(document.body.style.overflow).toBe("");
    expect(container.querySelector("[inert]")).toBeNull();
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("restores focus through Close and keeps the controls id stable after reopening", async () => {
    const container = await mount();
    const trigger = await open(container);
    const id = trigger.getAttribute("aria-controls");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close source"]')!.click()
    );
    expect(document.activeElement).toBe(trigger);
    await open(container);
    expect(trigger.getAttribute("aria-controls")).toBe(id);
  });

  it("does not trap Tab or steal focus when an outside control dismisses it", async () => {
    const container = await mount(
      <>
        <SourceChips cards={[card]} />
        <button data-outside>Other action</button>
      </>
    );
    await open(container);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    const outside = container.querySelector<HTMLButtonElement>("[data-outside]")!;
    outside.focus();
    await act(async () => outside.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("stays open for an inside pointer click and toggles closed on its opener", async () => {
    const container = await mount();
    const trigger = await open(container);
    await act(async () => container.querySelector<HTMLElement>(".source-tray__snippet")!.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    trigger.focus();
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("owns Escape inside a parent dialog without closing or unlocking the parent", async () => {
    const parentClose = vi.fn();
    const container = await mount(
      <Dialog title="Chat" onClose={parentClose}>
        <SourceChips cards={[card]} />
      </Dialog>
    );
    const trigger = await open(container);
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(parentClose).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("switches source focus without an outside-click handler closing the replacement", async () => {
    const second = { ...card, supportId: "S2", title: "Second plan" };
    const container = await mount(<SourceChips cards={[card, second]} />);
    await open(container);
    const trigger = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]'
    )[1]!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Source: Second plan"
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close source");
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves citation filtering, meeting delegation and display-marker behavior", async () => {
    const meeting = {
      ...card,
      supportId: "S2",
      sourceKind: "meeting" as const,
      sourceLabel: "Meeting note"
    };
    const container = await mount(
      <SourceChips cards={[card, meeting]} citedIds={["S2"]} messageId="message-test" />
    );
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
    expect(container.querySelector('[data-meeting-message="message-test"]')?.textContent).toBe(
      "Meeting note"
    );
    expect(stripDisplayMarkers("Known [[S1]], unknown [[S2]]", new Set(["S1"]))).toBe(
      "Known , unknown [[S2]]"
    );
  });
});
