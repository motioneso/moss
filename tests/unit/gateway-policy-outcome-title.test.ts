import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutoRunRateLimiter } from "../../packages/ai/src/gateway/auto-run-rate-limit.js";
import { CONTEXT_ADMISSION_UNAVAILABLE } from "../../packages/ai/src/gateway/content-admission.js";
import { admissionFixture, admissionTool } from "./helpers/gateway-admission-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("rate-limit refusal titles", () => {
  it.each(["tool", "gate"] as const)(
    "keeps a frozen authored title on the %s refusal",
    async (entry) => {
      vi.spyOn(AutoRunRateLimiter.prototype, "consume").mockReturnValue(false);
      const summarize = vi.fn(() => "Rename your morning meeting");
      const tool = admissionTool("calendar.renameMeeting", { risk: "write", summarize });
      const h = admissionFixture([tool]);
      const response =
        entry === "tool"
          ? await h.gateway.callTool(h.token, tool.name, {})
          : await h.gateway.callToolForGate(h.token, tool.name, {}, "execute");
      expect(response).toMatchObject(
        entry === "tool"
          ? { ok: false, denied: true }
          : { kind: "declined", reason: "rate_limited" }
      );
      summarize.mockReturnValue("A later title");
      expect(h.records).toMatchObject([
        {
          kind: "action_result",
          summary: "Rename your morning meeting",
          outcome: "denied",
          decidedBy: "policy"
        }
      ]);
      expect(summarize).toHaveBeenCalledOnce();
      expect(tool.execute).not.toHaveBeenCalled();
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "calendar.renameMeeting", "Run /private/script.sh"])(
    "uses a fixed generic title when no safe authored name exists: %s",
    async (summary) => {
      vi.spyOn(AutoRunRateLimiter.prototype, "consume").mockReturnValue(false);
      const tool = admissionTool("calendar.renameMeeting", {
        risk: "write",
        actionLabel: undefined,
        approvalPresentation: undefined,
        ...(summary ? { summarize: () => summary } : {})
      });
      const h = admissionFixture([tool]);
      await h.gateway.callTool(h.token, tool.name, {});
      expect(h.records[0]).toMatchObject({ summary: "Perform action", outcome: "denied" });
      expect(tool.execute).not.toHaveBeenCalled();
    }
  );

  it("keeps classifier dry-run refusal silent and does not render a title", async () => {
    vi.spyOn(AutoRunRateLimiter.prototype, "wouldAllow").mockReturnValue(false);
    const summarize = vi.fn(() => "Rename your meeting");
    const tool = admissionTool("calendar.renameMeeting", { risk: "write", summarize });
    const h = admissionFixture([tool]);
    expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "dry-run")).toEqual({
      kind: "declined",
      reason: "rate_limited"
    });
    expect(h.records).toEqual([]);
    expect(summarize).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

describe("native permission policy refusal titles", () => {
  it.each([false, true])(
    "names a provenance failure without private input (YOLO=%s)",
    async (yolo) => {
      const h = admissionFixture([], { deps: { yoloMode: async () => yolo } });
      h.recordAdmission.mockRejectedValue(new Error("private provenance detail"));
      const pending = h.gateway.requestNativeToolPermission(h.token, {
        toolName: "Write",
        toolInput: {
          file_path: join(tmpdir(), "private-policy-target.txt"),
          content: "private content"
        },
        workingDirectory: tmpdir()
      });
      if (!yolo) {
        await vi.waitFor(() => expect(h.records[0]?.kind).toBe("action_request"));
        h.confirmations.resolve("action-1", "confirmed");
      }
      expect(await pending).toMatchObject({
        decision: "deny",
        reason: CONTEXT_ADMISSION_UNAVAILABLE
      });
      const result = h.records.find((record) => record.kind === "action_result");
      expect(result).toMatchObject({
        summary: "Change files",
        outcome: "denied",
        decidedBy: "policy"
      });
      expect(JSON.stringify(result)).not.toContain("private-policy-target");
      expect(JSON.stringify(result)).not.toContain("private content");
      expect(JSON.stringify(result)).not.toContain("private provenance detail");
      expect(
        h.records.some((record) => record.kind === "action_result" && record.outcome === "allowed")
      ).toBe(false);
    }
  );

  it("keeps a successful native permission grant as allowed, never executed", async () => {
    const h = admissionFixture([], { deps: { yoloMode: async () => false } });
    const pending = h.gateway.requestNativeToolPermission(h.token, {
      toolName: "Bash",
      toolInput: { command: "echo private-command" }
    });
    await vi.waitFor(() => expect(h.records[0]?.kind).toBe("action_request"));
    h.confirmations.resolve("action-1", "confirmed");
    expect(await pending).toMatchObject({ decision: "allow" });
    const result = h.records.find((record) => record.kind === "action_result");
    expect(result).toMatchObject({ outcome: "allowed", decidedBy: "person" });
    expect(result).not.toHaveProperty("summary");
  });
});

const acpBase = {
  cwd: "/workspace/project",
  home: "/home/agent",
  sessionId: "session-1",
  turnId: "turn-1",
  toolCallId: "call-1",
  title: "private model-owned title"
};

describe("ACP policy refusal titles", () => {
  it.each([false, true])(
    "freezes a canonical command label on provenance refusal (YOLO=%s)",
    async (yolo) => {
      const h = admissionFixture([], { deps: { yoloMode: async () => yolo } });
      h.recordAdmission.mockRejectedValue(new Error("private provenance detail"));
      const request = { ...acpBase, toolName: "Bash", toolInput: { command: "private command" } };
      const pending = h.gateway.requestAcpBuiltInPermission(h.token, request);
      if (!yolo) {
        await vi.waitFor(() => expect(h.records[0]?.kind).toBe("action_request"));
        request.toolName = "Read";
        h.confirmations.resolve("action-1", "confirmed");
      }
      expect(await pending).toMatchObject({
        decision: "deny",
        reason: CONTEXT_ADMISSION_UNAVAILABLE
      });
      const result = h.records.find((record) => record.kind === "action_result");
      expect(result).toMatchObject({
        summary: "Run a command",
        outcome: "denied",
        decidedBy: "policy"
      });
      expect(JSON.stringify(result)).not.toContain("private command");
      expect(JSON.stringify(result)).not.toContain("private model-owned title");
      expect(JSON.stringify(result)).not.toContain("private provenance detail");
    }
  );

  it.each([
    { toolName: "Read", toolInput: { file_path: "/proc/self/environ" }, summary: "Read files" },
    { toolName: "private_unknown_tool", toolInput: {}, summary: "Perform action" },
    { toolName: null, toolInput: {}, summary: "Perform action" }
  ])("names an automatic hard refusal of $toolName without a model title", async (example) => {
    const h = admissionFixture([]);
    expect(
      await h.gateway.requestAcpBuiltInPermission(h.token, { ...acpBase, ...example })
    ).toMatchObject({
      decision: "deny",
      asked: false
    });
    expect(h.records[0]).toMatchObject({
      summary: example.summary,
      outcome: "denied",
      decidedBy: "policy"
    });
    expect(JSON.stringify(h.records)).not.toContain("private model-owned title");
  });
});
