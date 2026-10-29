import { createElement, Suspense, type ComponentType } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { installBuiltInVisualTemplates, type VisualReplyV1 } from "@moss/shared";
import VisualRenderer from "../../apps/web/src/chat/visual-renderer.js";

type Contribution = { default: Record<string, ComponentType> };
const loading = vi.hoisted(() => ({
  releases: [] as ((value: Contribution) => void)[],
  load: vi.fn(() => new Promise<Contribution>((resolve) => loading.releases.push(resolve)))
}));
vi.mock("virtual:moss-module-web", () => ({ MODULE_VISUAL_RENDERERS: [loading.load] }));

installBuiltInVisualTemplates([
  { kind: "test.result", snapshotKind: "test.result", validate: () => true, format: () => "Result" }
]);
const reply: VisualReplyV1 = {
  version: 1,
  catalogVersion: "moss.builtins.1",
  blocks: [{ blockId: "block", kind: "test.result", snapshotRefs: ["snapshot"] }],
  snapshots: [
    {
      ref: "snapshot",
      kind: "test.result",
      origin: "source",
      source: { id: "test", label: "Test source" },
      retrievedAt: "2026-10-23T12:00:00Z",
      coverage: "One result",
      fields: { value: 2 }
    }
  ],
  interactions: [],
  fallbackText: "Result: 2"
};

describe("lazy sourced visual rendering", () => {
  it("finishes initial suspension and reuses the loaded renderer", async () => {
    let renderer!: ReactTestRenderer;
    const element = () =>
      createElement(
        Suspense,
        { fallback: "Preparing visual" },
        createElement(VisualRenderer, { reply })
      );
    try {
      await act(async () => {
        renderer = create(element());
      });
      expect(renderer.toJSON()).toBe("Preparing visual");
      await act(async () => {
        loading.releases[0]!({
          default: { "test.result": () => createElement("p", null, "Source card") }
        });
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Source card");
      await act(async () => {
        renderer.update(element());
      });
      expect(loading.load).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});
