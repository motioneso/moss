// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  PlanApprovalCard,
  type ModuleBuildPlan
} from "../../apps/web/src/chat/plan-approval-card.js";

const plan: ModuleBuildPlan = {
  whatItDoes: "A page called Mythical in your sidebar.",
  whatItReaches: ["YouTube"],
  whatItKeeps: "Nothing. It reads the channels each time it runs.",
  whenItRuns: "Every morning at 7, and whenever you open the page.",
  roughCost: { time: "Ten minutes", budgetCents: 60 }
};

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

function renderCard(props: {
  readonly plan: ModuleBuildPlan;
  readonly onBuildIt: () => void;
  readonly onNotYet: () => void;
  readonly superseded?: boolean;
}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(PlanApprovalCard, props));
  });
  return renderer;
}

describe("PlanApprovalCard", () => {
  it("renders the plan without unreliable cost or time estimates", () => {
    const renderer = renderCard({ plan, onBuildIt: () => {}, onNotYet: () => {} });
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("What it does");
    expect(text).toContain(plan.whatItDoes);
    expect(text).toContain("What it reaches");
    expect(text).toContain("YouTube");
    expect(text).toContain("What it keeps");
    expect(text).toContain(plan.whatItKeeps);
    expect(text).toContain("When it runs");
    expect(text).toContain(plan.whenItRuns);
    expect(text).not.toContain("Roughly");
    expect(text).not.toContain("Ten minutes");
    expect(text).not.toContain("$");
    expect(text.toLowerCase()).not.toContain("budget");
  });

  it("calls onBuildIt and onNotYet from their own buttons", () => {
    const onBuildIt = vi.fn();
    const onNotYet = vi.fn();
    const renderer = renderCard({ plan, onBuildIt, onNotYet });

    const buildButton = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Build it"));
    const notYetButton = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Not yet"));
    if (!buildButton || !notYetButton) throw new Error("Plan card buttons not found");

    act(() => {
      buildButton.props.onClick();
    });
    expect(onBuildIt).toHaveBeenCalledOnce();
    expect(onNotYet).not.toHaveBeenCalled();

    act(() => {
      notYetButton.props.onClick();
    });
    expect(onNotYet).toHaveBeenCalledOnce();
  });

  it("renders as a plain message with no buttons once superseded", () => {
    const renderer = renderCard({
      plan,
      onBuildIt: () => {},
      onNotYet: () => {},
      superseded: true
    });
    const text = renderedText(renderer.toJSON());
    expect(text).toContain(plan.whatItDoes);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });
});
