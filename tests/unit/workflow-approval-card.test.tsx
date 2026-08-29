// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../apps/web/src/api/client.js";
import { resolveWorkflowApproval } from "../../apps/web/src/api/workflows-client.js";
import {
  WorkflowApprovalCard,
  type WorkflowApprovalCardProps
} from "../../apps/web/src/chat/workflow-approval-card.js";

vi.mock("../../apps/web/src/api/workflows-client.js", () => ({
  resolveWorkflowApproval: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const approval = {
  approval: {
    id: "approval-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    status: "approved" as const,
    summary: "Approve the expense",
    resolvedByUserId: "owner-1",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z"
  },
  step: {
    id: "step-1",
    workflowRunId: "run-1",
    stepId: "approval",
    status: "succeeded" as const,
    attemptCount: 1,
    errorCode: null,
    startedAt: null,
    suspendedAt: null,
    completedAt: "2026-08-28T00:00:00.000Z"
  }
};

function renderedText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "object" && "children" in (node as Record<string, unknown>)) {
    return renderedText((node as { children: unknown }).children);
  }
  return "";
}

function renderCard(props: Partial<WorkflowApprovalCardProps> = {}): ReactTestRenderer {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(WorkflowApprovalCard, {
          approvalId: "approval-1",
          summary: "Approve the expense",
          ...props
        })
      )
    );
  });
  return renderer;
}

describe("WorkflowApprovalCard", () => {
  beforeEach(() => vi.mocked(resolveWorkflowApproval).mockReset());

  it("shows only the safe summary and both decisions", () => {
    const renderer = renderCard();
    expect(renderedText(renderer.toJSON())).toContain("Approve the expense");
    expect(
      renderer.root
        .findAllByType("button")
        .map((button) => button.children.filter((child) => typeof child === "string").join(""))
    ).toEqual(["Approve", "Reject"]);
  });

  it("prevents double submission and shows the resolved state", async () => {
    let resolve!: (value: typeof approval) => void;
    vi.mocked(resolveWorkflowApproval).mockReturnValue(new Promise((done) => (resolve = done)));
    const renderer = renderCard();
    const [approve, reject] = renderer.root.findAllByType("button");
    const rejectClick = reject!.props.onClick as () => void;

    await act(async () => {
      approve!.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => rejectClick());
    expect(resolveWorkflowApproval).toHaveBeenCalledOnce();
    expect(renderedText(renderer.toJSON())).toContain("Resolving");

    await act(async () => {
      resolve(approval);
      await vi.waitFor(() => {
        expect(renderedText(renderer.toJSON())).toContain("Approved");
      });
    });
    expect(renderedText(renderer.toJSON())).toContain("Approved");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });

  it("shows a clear message when another request already answered it", async () => {
    vi.mocked(resolveWorkflowApproval).mockRejectedValueOnce(
      new ApiError(409, "This approval has already been answered")
    );
    const renderer = renderCard();
    await act(async () => {
      renderer.root.findAllByType("button")[0]!.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renderedText(renderer.toJSON())).toContain("This approval has already been answered");
  });

  it("renders an already-resolved approval without controls", () => {
    const renderer = renderCard({ status: "denied" });
    expect(renderedText(renderer.toJSON())).toContain("Not approved");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
  });
});
