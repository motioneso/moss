import { describe, expect, it, vi } from "vitest";

import { HttpError, type ModuleAssistantToolManifest } from "@moss/module-sdk";

import { CONTEXT_ADMISSION_UNAVAILABLE } from "../../packages/ai/src/gateway/content-admission.js";
import {
  admissionFixture,
  admissionModule,
  admissionTool,
  deferred,
  untrustedWrite
} from "./helpers/gateway-admission-fixture.js";

const outside = "Outside content after trusted owner descriptor listing";
const ownedTool = (overrides: Partial<ModuleAssistantToolManifest> = {}) =>
  admissionTool("example.owned", {
    isExternal: true,
    descriptorOwnerUserId: "actor-a",
    ...overrides
  });
const writeTool = () => untrustedWrite();

describe("actor-owned descriptor admission", () => {
  it("keeps exact owner descriptors clean so an existing YOLO write can execute", async () => {
    const write = writeTool();
    const h = admissionFixture([ownedTool(), write]);
    expect(await h.gateway.listToolsForSession(h.token)).toHaveLength(2);
    expect(h.recordAdmission).not.toHaveBeenCalled();
    expect(h.state.tainted).toBe(false);
    expect(await h.gateway.callToolForGate(h.token, write.name, {}, "dry-run")).toEqual({
      kind: "would_run",
      approvalMode: "yolo"
    });
    expect(await h.gateway.callTool(h.token, write.name, {})).toMatchObject({ ok: true });
    expect(write.execute).toHaveBeenCalledOnce();
    expect(h.runAutomatic).toHaveBeenCalledOnce();
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it.each([
    ["another owner", { descriptorOwnerUserId: "actor-b" }],
    ["missing owner", { descriptorOwnerUserId: undefined }],
    ["empty owner", { descriptorOwnerUserId: "" }],
    ["nonexact owner", { descriptorOwnerUserId: "ACTOR-A" }],
    ["unknown origin despite matching owner", { isExternal: undefined }],
    ["malformed origin despite matching owner", { isExternal: "true" as unknown as boolean }]
  ] as const)("taints %s descriptors and blocks a later YOLO write", async (_label, stamp) => {
    const write = writeTool();
    const h = admissionFixture([ownedTool(stamp), write]);
    expect(await h.gateway.listToolsForSession(h.token)).toHaveLength(2);
    expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "actor-a",
      "thread-a",
      "tool_external_descriptors"
    );
    expect(h.state.tainted).toBe(true);
    expect(await h.gateway.callToolForGate(h.token, write.name, {}, "dry-run")).toEqual({
      kind: "declined",
      reason: "would_confirm"
    });
    expect(write.execute).not.toHaveBeenCalled();
  });

  it("taints a mixed listing even when its first descriptor belongs to the actor", async () => {
    const h = admissionFixture([
      ownedTool(),
      admissionTool("example.foreign", { isExternal: true, descriptorOwnerUserId: "actor-b" })
    ]);
    expect(await h.gateway.listToolsForSession(h.token)).toHaveLength(2);
    expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "actor-a",
      "thread-a",
      "tool_external_descriptors"
    );
    expect(h.state.tainted).toBe(true);
  });

  it.each([
    { label: "empty", tools: [] },
    { label: "built-in", tools: [admissionTool("example.builtin")] },
    { label: "owned", tools: [ownedTool()] }
  ])(
    "refuses factory/token actor mismatch even for clean $label descriptors",
    async ({ tools }) => {
      const h = admissionFixture(tools);
      await expect(
        h.gateway.admitToolDescriptorsForSession(h.token, "actor-b", tools)
      ).rejects.toThrow(CONTEXT_ADMISSION_UNAVAILABLE);
      expect(h.recordAdmission).not.toHaveBeenCalled();
    }
  );

  it("reverifies a token revoked while clean owner descriptors are resolving", async () => {
    const started = deferred();
    const finish = deferred();
    const h = admissionFixture([], {
      deps: {
        resolveActiveModules: async () => {
          started.resolve();
          await finish.promise;
          return [admissionModule([ownedTool()])];
        }
      }
    });
    let exposed = false;
    const pending = h.gateway.listToolsForSession(h.token).then((tools) => {
      exposed = true;
      return tools;
    });
    const refused = expect(pending).rejects.toThrow("Invalid or revoked session token");
    await started.promise;
    h.tokens.revoke(h.token);
    finish.resolve();
    await refused;
    expect(exposed).toBe(false);
    expect(h.recordAdmission).not.toHaveBeenCalled();
  });

  it("requires a live token even when direct descriptor admission would stay clean", async () => {
    const h = admissionFixture([]);
    for (const token of ["invalid-token", h.token]) {
      if (token === h.token) h.tokens.revoke(token);
      await expect(
        h.gateway.admitToolDescriptorsForSession(token, "actor-a", [ownedTool()])
      ).rejects.toThrow("Invalid or revoked session token");
    }
    expect(h.recordAdmission).not.toHaveBeenCalled();
  });
});

describe("owner descriptor trust does not extend to returned content", () => {
  it.each(["result", "forwarded error"] as const)(
    "admits the owned tool's %s after its clean listing and blocks the next YOLO write",
    async (kind) => {
      const tool = ownedTool({
        safeErrors: true,
        execute: async () => {
          if (kind === "forwarded error") throw new HttpError(400, outside);
          return { data: { value: outside } };
        }
      });
      const write = writeTool();
      const h = admissionFixture([tool, write]);
      await h.gateway.listToolsForSession(h.token);
      expect(h.state.tainted).toBe(false);
      const result = await h.gateway.callTool(h.token, tool.name, {});
      expect(result).toMatchObject({ ok: kind === "result" });
      expect(JSON.stringify(result)).toContain(outside);
      expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith(
        "actor-a",
        "thread-a",
        "tool_external_content"
      );
      expect(h.state.tainted).toBe(true);
      expect(await h.gateway.callToolForGate(h.token, write.name, {}, "dry-run")).toEqual({
        kind: "declined",
        reason: "would_confirm"
      });
    }
  );

  it.each(["result", "forwarded error"] as const)(
    "withholds an owned tool's %s if admission fails after a clean listing",
    async (kind) => {
      const tool = ownedTool({
        safeErrors: true,
        execute: async () => {
          if (kind === "forwarded error") throw new HttpError(400, outside);
          return { data: { value: outside } };
        }
      });
      const h = admissionFixture([tool]);
      await h.gateway.listToolsForSession(h.token);
      expect(h.recordAdmission).not.toHaveBeenCalled();
      h.recordAdmission.mockRejectedValue(new Error("private storage failure"));
      expect(await h.gateway.callTool(h.token, tool.name, {})).toEqual({
        ok: false,
        error: CONTEXT_ADMISSION_UNAVAILABLE
      });
    }
  );

  it("admits owned tool progress before exposure after its clean listing", async () => {
    const finish = deferred();
    const admission = deferred();
    const tool = ownedTool({
      execute: async (_db, _input, ctx) => {
        ctx.reportProgress?.(outside);
        await finish.promise;
        return { data: {} };
      }
    });
    const h = admissionFixture([tool]);
    await h.gateway.listToolsForSession(h.token);
    expect(h.recordAdmission).not.toHaveBeenCalled();
    const record = h.recordAdmission.getMockImplementation()!;
    h.recordAdmission.mockImplementation(async (...args) => {
      await admission.promise;
      await record(...args);
    });
    const onProgress = vi.fn();
    const pending = h.gateway.callTool(h.token, tool.name, {}, { onProgress });
    await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce());
    expect(onProgress).not.toHaveBeenCalled();
    admission.resolve();
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledExactlyOnceWith(outside));
    expect(h.state.tainted).toBe(true);
    finish.resolve();
    expect(await pending).toMatchObject({ ok: true });
  });

  it("still admits model-visible validation diagnostics after a clean owned listing", async () => {
    const tool = ownedTool({
      inputSchema: {
        type: "object",
        properties: { choice: { type: "string", enum: [outside] } },
        required: ["choice"]
      }
    });
    const h = admissionFixture([tool]);
    await h.gateway.listToolsForSession(h.token);
    expect(h.recordAdmission).not.toHaveBeenCalled();
    expect(await h.gateway.callTool(h.token, tool.name, { choice: "invalid" })).toEqual({
      ok: false,
      error: expect.stringContaining(outside)
    });
    expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "actor-a",
      "thread-a",
      "tool_external_descriptors"
    );
    expect(h.state.tainted).toBe(true);
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
