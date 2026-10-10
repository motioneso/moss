import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AcpBuiltInPermissionRequest, AdmissionPath } from "@moss/ai";

import { CONTEXT_ADMISSION_UNAVAILABLE } from "../../packages/ai/src/gateway/content-admission.js";
import {
  admissionFixture,
  deferred,
  rejectAdmissionCard,
  untrustedWrite
} from "./helpers/gateway-admission-fixture.js";

const acpBase = {
  cwd: "/workspace/project",
  home: "/home/agent",
  sessionId: "agent-session",
  turnId: "turn-1",
  toolCallId: "call-1",
  title: "Read outside data"
};
const acpCases: Array<{
  label: string;
  input: Pick<AcpBuiltInPermissionRequest, "toolName" | "toolInput">;
  path: AdmissionPath;
  mode: "policy" | "yolo" | "person";
  guard: boolean;
}> = [
  {
    label: "local read",
    input: { toolName: "Read", toolInput: { file_path: "/workspace/project/file.txt" } },
    path: "outside_agent_read",
    mode: "policy",
    guard: false
  },
  {
    label: "YOLO outside read",
    input: { toolName: "Read", toolInput: { file_path: "/elsewhere/file.txt" } },
    path: "outside_agent_read",
    mode: "yolo",
    guard: true
  },
  {
    label: "approved outside read",
    input: { toolName: "Read", toolInput: { file_path: "/elsewhere/file.txt" } },
    path: "outside_agent_read",
    mode: "person",
    guard: false
  },
  {
    label: "public web fetch",
    input: { toolName: "WebFetch", toolInput: { url: "https://example.com" } },
    path: "outside_agent_web",
    mode: "policy",
    guard: true
  },
  {
    label: "web search",
    input: { toolName: "WebSearch", toolInput: { query: "public topic" } },
    path: "outside_agent_web",
    mode: "policy",
    guard: true
  },
  {
    label: "YOLO local web fetch",
    input: { toolName: "WebFetch", toolInput: { url: "http://localhost" } },
    path: "outside_agent_web",
    mode: "yolo",
    guard: true
  },
  {
    label: "approved local web fetch",
    input: { toolName: "WebFetch", toolInput: { url: "http://localhost" } },
    path: "outside_agent_web",
    mode: "person",
    guard: false
  },
  {
    label: "YOLO shell",
    input: { toolName: "Bash", toolInput: { command: "echo hello" } },
    path: "outside_agent_shell",
    mode: "yolo",
    guard: true
  },
  {
    label: "approved shell",
    input: { toolName: "Bash", toolInput: { command: "echo hello" } },
    path: "outside_agent_shell",
    mode: "person",
    guard: false
  }
];

async function approve(h: ReturnType<typeof admissionFixture>) {
  await vi.waitFor(
    () => expect(h.records.some((record) => record.kind === "action_request")).toBe(true),
    { interval: 1 }
  );
  h.confirmations.resolve("action-1", "confirmed");
}

describe("outside-agent permission admission", () => {
  it.each(acpCases)(
    "records $label before its allow response, after any reservation release",
    async ({ input, path, mode, guard }) => {
      const h = admissionFixture([], { deps: { yoloMode: async () => mode === "yolo" } });
      const admission = deferred();
      h.recordAdmission.mockImplementation(async (actor, thread, reported) => {
        expect([actor, thread, reported]).toEqual(["actor-a", "thread-a", path]);
        expect(h.state.held).toBe(false);
        await admission.promise;
        h.events.push(`admit:${reported}`);
      });
      let allowed = false;
      const pending = h.gateway
        .requestAcpBuiltInPermission(h.token, { ...acpBase, ...input })
        .then((result) => {
          allowed = result.decision === "allow";
          return result;
        });
      if (mode === "person") await approve(h);
      await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce(), { interval: 1 });
      expect(allowed).toBe(false);
      expect(h.records.some((r) => r.kind === "action_result" && r.outcome === "allowed")).toBe(
        false
      );
      admission.resolve();
      expect(await pending).toMatchObject({ decision: "allow", asked: mode === "person" });
      expect(h.events).toEqual([...(guard ? ["claim", "release"] : []), `admit:${path}`]);
    }
  );

  it.each(acpCases)("denies $label when admission fails", async ({ input, mode }) => {
    const h = admissionFixture([], { deps: { yoloMode: async () => mode === "yolo" } });
    h.recordAdmission.mockRejectedValue(new Error("private ACP admission detail"));
    const pending = h.gateway.requestAcpBuiltInPermission(h.token, { ...acpBase, ...input });
    if (mode === "person") await approve(h);
    expect(await pending).toMatchObject({
      decision: "deny",
      reason: CONTEXT_ADMISSION_UNAVAILABLE
    });
    expect(h.recordAdmission).toHaveBeenCalledOnce();
    expect(h.records.some((r) => r.kind === "action_result" && r.outcome === "allowed")).toBe(
      false
    );
    expect(JSON.stringify(h.records)).not.toContain("private ACP admission detail");
  });

  it.each(acpCases.filter(({ mode }) => mode !== "person"))(
    "$label makes a following untrusted write ask",
    async ({ input }) => {
      const tool = untrustedWrite();
      const h = admissionFixture([tool]);
      expect(
        await h.gateway.requestAcpBuiltInPermission(h.token, { ...acpBase, ...input })
      ).toMatchObject({ decision: "allow" });
      expect(h.state.tainted).toBe(true);
      await rejectAdmissionCard(h, h.gateway.callTool(h.token, tool.name, {}));
      expect(tool.execute).not.toHaveBeenCalled();
    }
  );

  it("keeps hard-denied requests clean", async () => {
    const h = admissionFixture([]);
    expect(
      await h.gateway.requestAcpBuiltInPermission(h.token, {
        ...acpBase,
        toolName: "Read",
        toolInput: { file_path: "/proc/self/environ" }
      })
    ).toMatchObject({ decision: "deny", asked: false });
    expect(h.recordAdmission).not.toHaveBeenCalled();
  });
});

describe("permission audit interleavings", () => {
  it("holds the native pending-row wait inside the automatic claim", async () => {
    const h = admissionFixture([]);
    const creation = deferred();
    h.createPending.mockImplementation(async () => {
      await creation.promise;
      return { id: "action-1" };
    });
    const pending = h.gateway.requestNativeToolPermission(h.token, {
      toolName: "Write",
      workingDirectory: tmpdir(),
      toolInput: { file_path: join(tmpdir(), "moss-admission-fixture.txt") }
    });
    await vi.waitFor(() => expect(h.state.held).toBe(true), { interval: 1 });
    await expect(h.gateway.recordContextForSession(h.token, "recall_notes")).rejects.toThrow(
      CONTEXT_ADMISSION_UNAVAILABLE
    );
    expect(h.events).toEqual(["claim"]);
    expect(h.deps.repository.resolveAssistantAction).not.toHaveBeenCalled();
    creation.resolve();
    expect(await pending).toMatchObject({ decision: "allow" });
    expect(h.events).toEqual(["claim", "release", "admit:native_tool_result"]);
    expect(h.state.held).toBe(false);
  });

  it("records durable outside-agent taint before the post-admission audit wait", async () => {
    const tool = untrustedWrite();
    const h = admissionFixture([tool]);
    const audit = deferred();
    h.audit.mockImplementation(async () => {
      await audit.promise;
    });
    let allowed = false;
    const pending = h.gateway
      .requestAcpBuiltInPermission(h.token, {
        ...acpBase,
        toolName: "Bash",
        toolInput: { command: "echo hello" }
      })
      .then((result) => {
        allowed = result.decision === "allow";
        return result;
      });
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalledOnce(), { interval: 1 });
    expect(h.state.held).toBe(false);
    expect(h.state.tainted).toBe(true);
    expect(allowed).toBe(false);
    expect(h.events).toEqual(["claim", "release", "admit:outside_agent_shell"]);
    expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")).toEqual({
      kind: "declined",
      reason: "would_confirm"
    });
    expect(tool.execute).not.toHaveBeenCalled();
    await h.gateway.recordContextForSession(h.token, "recall_notes");
    audit.resolve();
    expect(await pending).toMatchObject({ decision: "allow" });
    expect(h.audit).toHaveBeenCalledOnce();
  });

  it("keeps a YOLO outside-agent write audit guarded when there is no admission path", async () => {
    const h = admissionFixture([]);
    const audit = deferred();
    h.audit.mockImplementation(async () => {
      await audit.promise;
    });
    const pending = h.gateway.requestAcpBuiltInPermission(h.token, {
      ...acpBase,
      toolName: "Write",
      toolInput: { file_path: "/elsewhere/file.txt" }
    });
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalledOnce(), { interval: 1 });
    expect(h.state.held).toBe(true);
    expect(h.recordAdmission).not.toHaveBeenCalled();
    await expect(h.gateway.recordContextForSession(h.token, "recall_notes")).rejects.toThrow(
      CONTEXT_ADMISSION_UNAVAILABLE
    );
    audit.resolve();
    expect(await pending).toMatchObject({ decision: "allow" });
    expect(h.events).toEqual(["claim", "release"]);
    expect(h.state.tainted).toBe(false);
    expect(h.audit).toHaveBeenCalledOnce();
  });
});

describe("native permission conservative admission", () => {
  it.each(["yolo", "person"] as const)(
    "records before allowing native results (%s)",
    async (mode) => {
      const h = admissionFixture([], { deps: { yoloMode: async () => mode === "yolo" } });
      const admission = deferred();
      h.recordAdmission.mockImplementation(async (actor, thread, path) => {
        expect([actor, thread, path]).toEqual(["actor-a", "thread-a", "native_tool_result"]);
        expect(h.state.held).toBe(false);
        await admission.promise;
        h.events.push(`admit:${path}`);
      });
      let allowed = false;
      const pending = h.gateway
        .requestNativeToolPermission(h.token, {
          toolName: mode === "yolo" ? "Write" : "Read",
          workingDirectory: tmpdir(),
          toolInput: { file_path: join(tmpdir(), "moss-admission-fixture.txt") }
        })
        .then((result) => {
          allowed = result.decision === "allow";
          return result;
        });
      if (mode === "person") await approve(h);
      await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce(), { interval: 1 });
      expect(allowed).toBe(false);
      admission.resolve();
      expect(await pending).toMatchObject({ decision: "allow" });
      expect(h.events).toEqual([
        ...(mode === "yolo" ? ["claim", "release"] : []),
        "admit:native_tool_result"
      ]);
    }
  );

  it.each(["yolo", "person"] as const)(
    "denies native permission when admission fails (%s)",
    async (mode) => {
      const h = admissionFixture([], { deps: { yoloMode: async () => mode === "yolo" } });
      h.recordAdmission.mockRejectedValue(new Error("private native admission detail"));
      const pending = h.gateway.requestNativeToolPermission(h.token, {
        toolName: mode === "yolo" ? "Write" : "Read",
        workingDirectory: tmpdir(),
        toolInput: { file_path: join(tmpdir(), "moss-admission-fixture.txt") }
      });
      if (mode === "person") await approve(h);
      expect(await pending).toEqual({ decision: "deny", reason: CONTEXT_ADMISSION_UNAVAILABLE });
      expect(h.records.some((r) => r.kind === "action_result" && r.outcome === "allowed")).toBe(
        false
      );
    }
  );

  it.each(["ToolSearch", "mcp__jarvis__settings__change"])(
    "leaves %s to its existing downstream boundary",
    async (toolName) => {
      const h = admissionFixture([]);
      expect(
        await h.gateway.requestNativeToolPermission(h.token, { toolName, toolInput: {} })
      ).toMatchObject({ decision: "allow" });
      expect(h.recordAdmission).not.toHaveBeenCalled();
    }
  );
});

describe("native YOLO durable permission status", () => {
  const nativeWrite = {
    toolName: "Write",
    workingDirectory: tmpdir(),
    toolInput: { file_path: join(tmpdir(), "moss-admission-fixture.txt") }
  };

  it("creates pending under guard, then admits before confirming the permission", async () => {
    const tool = untrustedWrite();
    const h = admissionFixture([tool]);
    const admission = deferred();
    const resolution = deferred();
    const record = h.recordAdmission.getMockImplementation()!;
    const resolve = vi.mocked(h.deps.repository.resolveAssistantAction);
    const originalResolve = resolve.getMockImplementation()!;
    h.createPending.mockImplementation(async () => {
      expect(h.state.held).toBe(true);
      return { id: "action-1" };
    });
    h.recordAdmission.mockImplementation(async (...args) => {
      expect(h.createPending).toHaveBeenCalledOnce();
      expect(h.state.held).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      await admission.promise;
      return record(...args);
    });
    resolve.mockImplementation(async (...args) => {
      expect(h.state.held).toBe(false);
      expect(h.state.tainted).toBe(true);
      await resolution.promise;
      return originalResolve(...args);
    });
    let allowed = false;
    const pending = h.gateway.requestNativeToolPermission(h.token, nativeWrite).then((result) => {
      allowed = result.decision === "allow";
      return result;
    });
    await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce(), { interval: 1 });
    expect(resolve).not.toHaveBeenCalled();
    expect(allowed).toBe(false);
    admission.resolve();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce(), { interval: 1 });
    expect(resolve).toHaveBeenCalledWith({}, "action-1", { status: "confirmed" });
    expect(allowed).toBe(false);
    expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")).toEqual({
      kind: "declined",
      reason: "would_confirm"
    });
    expect(tool.execute).not.toHaveBeenCalled();
    resolution.resolve();
    expect(await pending).toMatchObject({ decision: "allow" });
    expect(h.events).toEqual(["claim", "release", "admit:native_tool_result"]);
    expect(h.runAutomatic).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "cancels after failed admission without falsely confirming, including cancellation failure=%s",
    async (cancellationFails) => {
      const h = admissionFixture([]);
      const resolve = vi.mocked(h.deps.repository.resolveAssistantAction);
      h.recordAdmission.mockRejectedValue(new Error("private admission detail"));
      if (cancellationFails) resolve.mockRejectedValue(new Error("private cancellation detail"));
      const result = await h.gateway.requestNativeToolPermission(h.token, nativeWrite);
      expect(result).toEqual({ decision: "deny", reason: CONTEXT_ADMISSION_UNAVAILABLE });
      expect(resolve).toHaveBeenCalledExactlyOnceWith({}, "action-1", { status: "cancelled" });
      expect(h.recordAdmission.mock.invocationCallOrder[0]).toBeLessThan(
        resolve.mock.invocationCallOrder[0]!
      );
      expect(h.createPending).toHaveBeenCalledOnce();
      expect(h.records).toEqual([
        expect.objectContaining({
          kind: "action_result",
          actionRequestId: "action-1",
          outcome: "denied",
          decidedBy: "policy",
          holdDurationMs: null,
          reason: CONTEXT_ADMISSION_UNAVAILABLE
        })
      ]);
      expect(JSON.stringify({ result, records: h.records })).not.toContain("private");
      expect(h.state.tainted).toBe(false);
    }
  );

  it.each(["missing row", "storage error"] as const)(
    "denies an unpersisted final permission grant after admission (%s)",
    async (failure) => {
      const h = admissionFixture([]);
      const resolve = vi.mocked(h.deps.repository.resolveAssistantAction);
      if (failure === "missing row") resolve.mockResolvedValue(undefined);
      else resolve.mockRejectedValue(new Error("private confirmation detail"));
      expect(await h.gateway.requestNativeToolPermission(h.token, nativeWrite)).toEqual({
        decision: "deny",
        reason: CONTEXT_ADMISSION_UNAVAILABLE
      });
      expect(h.state.tainted).toBe(true);
      expect(resolve).toHaveBeenCalledExactlyOnceWith({}, "action-1", { status: "confirmed" });
      expect(h.records).toEqual([
        expect.objectContaining({
          kind: "action_result",
          outcome: "denied",
          decidedBy: "policy"
        })
      ]);
      expect(h.createPending).toHaveBeenCalledOnce();
      expect(h.runAutomatic).toHaveBeenCalledOnce();
    }
  );
});

describe("outside-agent YOLO admission audit truth", () => {
  it.each(acpCases.filter(({ mode }) => mode === "yolo"))(
    "$label writes one success audit only after its admission succeeds",
    async ({ input, path }) => {
      const h = admissionFixture([]);
      const admission = deferred();
      const record = h.recordAdmission.getMockImplementation()!;
      h.recordAdmission.mockImplementation(async (...args) => {
        expect(h.state.held).toBe(false);
        expect(h.audit).not.toHaveBeenCalled();
        await admission.promise;
        return record(...args);
      });
      const pending = h.gateway.requestAcpBuiltInPermission(h.token, { ...acpBase, ...input });
      await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce(), { interval: 1 });
      expect(h.audit).not.toHaveBeenCalled();
      admission.resolve();
      expect(await pending).toMatchObject({ decision: "allow", asked: false });
      expect(h.events).toEqual(["claim", "release", `admit:${path}`]);
      expect(h.audit).toHaveBeenCalledExactlyOnceWith(
        {},
        expect.objectContaining({
          approvalMode: "yolo",
          outcome: "success",
          errorClass: null,
          inputSummary: expect.objectContaining({
            agent: expect.objectContaining({ decision: "allowed" })
          })
        })
      );
      expect(h.records).toEqual([]);
    }
  );

  it.each(acpCases.filter(({ mode }) => mode === "yolo"))(
    "$label writes one failed audit and policy denial when admission fails",
    async ({ input }) => {
      const h = admissionFixture([]);
      h.recordAdmission.mockRejectedValue(new Error("private admission detail"));
      const result = await h.gateway.requestAcpBuiltInPermission(h.token, { ...acpBase, ...input });
      expect(result).toMatchObject({
        decision: "deny",
        asked: false,
        reason: CONTEXT_ADMISSION_UNAVAILABLE
      });
      expect(h.audit).toHaveBeenCalledExactlyOnceWith(
        {},
        expect.objectContaining({
          approvalMode: "yolo",
          outcome: "failed",
          errorClass: "content_admission",
          inputSummary: expect.objectContaining({
            agent: expect.objectContaining({ decision: "refused" })
          })
        })
      );
      expect(h.recordAdmission.mock.invocationCallOrder[0]).toBeLessThan(
        h.audit.mock.invocationCallOrder[0]!
      );
      expect(h.records).toEqual([
        expect.objectContaining({
          kind: "action_result",
          actionRequestId: acpBase.toolCallId,
          outcome: "denied",
          decidedBy: "policy",
          reason: CONTEXT_ADMISSION_UNAVAILABLE
        })
      ]);
      expect(h.events).toEqual(["claim", "release"]);
      expect(
        JSON.stringify({ result, records: h.records, audit: h.audit.mock.calls })
      ).not.toContain("private admission detail");
    }
  );
});
