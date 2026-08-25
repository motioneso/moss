// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi, beforeEach } from "vitest";

const navigate = vi.fn();
vi.mock("react-router", () => ({
  useNavigate: () => navigate
}));

const approveModuleBuild = vi.fn();
vi.mock("../../apps/web/src/api/module-builds-client.js", () => ({
  approveModuleBuild: (buildId: string) => approveModuleBuild(buildId)
}));

const { ModuleBuildPlanRecord } =
  await import("../../apps/web/src/chat/module-build-plan-record.js");

const plan = {
  whatItDoes: "A page called Mythical in your sidebar.",
  whatItReaches: ["YouTube"],
  whatItKeeps: "Nothing. It reads the channels each time it runs.",
  whenItRuns: "Every morning at 7, and whenever you open the page.",
  roughCost: { time: "Ten minutes", budgetCents: 60 }
};

function clickBuildIt(renderer: ReactTestRenderer): void {
  const buildButton = renderer.root
    .findAllByType("button")
    .find((instance) => instance.children.includes("Build it"));
  if (!buildButton) throw new Error("Build it button not found");
  act(() => {
    buildButton.props.onClick();
  });
}

describe("ModuleBuildPlanRecord navigation", () => {
  beforeEach(() => {
    navigate.mockClear();
    approveModuleBuild.mockClear();
  });

  it("navigates to /workshop only after the approve call resolves", async () => {
    let resolveApprove!: () => void;
    approveModuleBuild.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveApprove = resolve;
      })
    );

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(ModuleBuildPlanRecord, { buildId: "b1", plan, awaitingApproval: true })
      );
    });

    clickBuildIt(renderer);
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      resolveApprove();
      await Promise.resolve();
    });

    expect(navigate).toHaveBeenCalledWith("/workshop");
  });

  it("does not navigate when the approve call is rejected", async () => {
    approveModuleBuild.mockReturnValue(Promise.reject(new Error("nope")));

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(ModuleBuildPlanRecord, { buildId: "b1", plan, awaitingApproval: true })
      );
    });

    await act(async () => {
      clickBuildIt(renderer);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigate).not.toHaveBeenCalled();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Could not start the build");
  });
});
