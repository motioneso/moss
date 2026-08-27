// #1975: proves the three Workshop buttons ("Stop", "Ask for a change", "Turn on for
// everyone") are actually wired to their callbacks with the right id, not just present on
// screen. Copies draft-banner.test.tsx's react-test-renderer + jsdom shape — the SSR test in
// workshop-groups.test.tsx cannot simulate a click at all.
// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { ModuleBuildSummary, WorkshopLiveModuleSummary } from "@moss/shared";

import {
  WorkshopGroups,
  type WorkshopActions,
  type WorkshopGroupsProps
} from "../../packages/workshop/src/web/workshop-groups.js";

function renderGroups(
  props: Omit<WorkshopGroupsProps, "actions"> & {
    readonly actions?: Partial<WorkshopActions>;
  }
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  const actions: WorkshopActions = {
    onApprove: vi.fn(),
    onCancel: vi.fn(),
    onOpenDraft: vi.fn(),
    onDiscardDraft: vi.fn(),
    onAskForChange: vi.fn(),
    onShip: vi.fn(),
    ...props.actions
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["settings", "locale"], {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "12" }
  });
  act(() => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(WorkshopGroups, { ...props, actions })
      )
    );
  });
  return renderer;
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType("button")
    .find((instance) => instance.children.includes(label));
}

function buildingBuild(overrides: Partial<ModuleBuildSummary> = {}): ModuleBuildSummary {
  return {
    id: "build-1",
    status: "building",
    step: "writing_code",
    moduleId: null,
    plan: null,
    fetchedUrls: [],
    writtenFiles: [],
    costCents: 0,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function liveModule(overrides: Partial<WorkshopLiveModuleSummary> = {}): WorkshopLiveModuleSummary {
  return { id: "mod-1", name: "Acme", version: "1.0.0", scope: "you", ...overrides };
}

describe("WorkshopGroups actions", () => {
  it("calls onStop with the build's id when Stop is clicked on a building card", () => {
    const onStop = vi.fn();
    const renderer = renderGroups({
      builds: [buildingBuild()],
      modules: [],
      actions: { onCancel: onStop }
    });

    const stopButton = findButton(renderer, "Stop");
    if (!stopButton) throw new Error("Stop button not found");
    act(() => stopButton.props.onClick());

    expect(onStop).toHaveBeenCalledWith("build-1");
  });

  it("calls onTurnOnForEveryone with the module's id for a module scoped to you", () => {
    const onTurnOnForEveryone = vi.fn();
    const renderer = renderGroups({
      builds: [],
      modules: [liveModule({ scope: "you" })],
      actions: { onShip: onTurnOnForEveryone }
    });

    const turnOnButton = findButton(renderer, "Turn on for everyone");
    if (!turnOnButton) throw new Error("Turn on for everyone button not found");
    act(() => turnOnButton.props.onClick());

    expect(onTurnOnForEveryone).toHaveBeenCalledWith("mod-1");
  });

  it("does not show Turn on for everyone for a module already live for everyone (regression)", () => {
    const renderer = renderGroups({ builds: [], modules: [liveModule({ scope: "everyone" })] });
    expect(findButton(renderer, "Turn on for everyone")).toBeUndefined();
  });

  it("calls onAskForChange with the module's id, for any scope", () => {
    const onAskForChange = vi.fn();
    const renderer = renderGroups({
      builds: [],
      modules: [liveModule({ id: "mod-2", scope: "everyone" })],
      actions: { onAskForChange }
    });

    const askButton = findButton(renderer, "Ask for a change");
    if (!askButton) throw new Error("Ask for a change button not found");
    act(() => askButton.props.onClick());

    expect(onAskForChange).toHaveBeenCalledWith("mod-2");
  });
});
