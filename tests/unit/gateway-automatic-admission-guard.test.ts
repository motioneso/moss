import { describe, expect, it, vi } from "vitest";

import type { ToolExecute } from "@moss/module-sdk";

import { CONTEXT_ADMISSION_UNAVAILABLE } from "../../packages/ai/src/gateway/content-admission.js";
import {
  admissionFixture,
  admissionTool,
  deferred,
  rejectAdmissionCard,
  resolvedCall
} from "./helpers/gateway-admission-fixture.js";

const failure = { ok: false, error: CONTEXT_ADMISSION_UNAVAILABLE };

describe("automatic dispatch admission guard", () => {
  it.each(["ordinary", "gate"] as const)(
    "holds the guard across transaction acquisition and handler await (%s)",
    async (entry) => {
      const transaction = deferred();
      const handler = deferred();
      const execute = vi.fn<ToolExecute>(async () => {
        expect(h.state.held).toBe(true);
        await handler.promise;
        expect(h.state.held).toBe(true);
        return { data: { saved: true } };
      });
      const tool = admissionTool("settings.themeMode.set", { risk: "write", execute });
      const h = admissionFixture([tool], {
        deps: {
          runner: {
            withDataContext: async (_access: unknown, work: (db: unknown) => unknown) => {
              // Only dispatch and its later audit use this fixture's DataContext.
              if (!execute.mock.calls.length) {
                expect(h.state.held).toBe(true);
                await transaction.promise;
              }
              return work({});
            }
          } as never
        }
      });
      const pending =
        entry === "gate"
          ? h.gateway.callToolForGate(h.token, tool.name, {}, "execute")
          : h.gateway.callTool(h.token, tool.name, {});
      await vi.waitFor(() => expect(h.state.held).toBe(true), { interval: 1 });
      expect(execute).not.toHaveBeenCalled();
      await expect(h.gateway.recordContextForSession(h.token, "recall_notes")).rejects.toThrow(
        CONTEXT_ADMISSION_UNAVAILABLE
      );
      transaction.resolve();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { interval: 1 });
      // Simulated caller disconnect: the token is revoked, but the actual handler still runs.
      h.tokens.revoke(h.token);
      expect(h.state.held).toBe(true);
      await expect(
        h.provenance.recordAdmission("actor-a", "thread-a", "recall_notes")
      ).rejects.toThrow();
      handler.resolve();
      expect(await pending).toMatchObject(
        entry === "gate" ? { kind: "executed", response: { ok: true } } : { ok: true }
      );
      expect(h.state.held).toBe(false);
      expect(h.events).toEqual(["claim", "release"]);
      await h.provenance.recordAdmission("actor-a", "thread-a", "recall_notes");
      expect(h.state.tainted).toBe(true);
    }
  );

  it("claims before composition-owned app transport preflight and admits after release", async () => {
    const preflight = deferred();
    const tool = admissionTool("app.callAction", {
      risk: "write",
      content: "outside",
      requiresServices: ["appActions"]
    });
    const dispatch = vi.fn(async () => {
      expect(h.state.held).toBe(true);
      h.events.push("preflight");
      await preflight.promise;
      h.events.push("dispatch");
      expect(h.state.held).toBe(true);
      return { data: { value: "outside route result" } };
    });
    const h = admissionFixture([tool], {
      deps: {
        toolServices: { appActions: {} },
        perCallResolvers: { [tool.name]: async () => resolvedCall({ externalContent: true }) },
        perCallServices: { [tool.name]: () => ({ appActions: {} }) },
        perCallExecutors: { [tool.name]: dispatch }
      }
    });
    const pending = h.gateway.callTool(h.token, tool.name, {});
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce(), { interval: 1 });
    await expect(h.gateway.recordContextForSession(h.token, "recall_notes")).rejects.toThrow(
      CONTEXT_ADMISSION_UNAVAILABLE
    );
    preflight.resolve();
    expect(await pending).toMatchObject({ ok: true });
    expect(h.events).toEqual([
      "claim",
      "preflight",
      "dispatch",
      "release",
      "admit:app_action_outside"
    ]);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it.each(["ordinary", "gate"] as const)(
    "a reservation refusal never dispatches automatically (%s)",
    async (entry) => {
      const tool = admissionTool("settings.themeMode.set", { risk: "write" });
      const h = admissionFixture([tool]);
      h.runAutomatic.mockResolvedValue({ kind: "confirm" });
      if (entry === "gate") {
        expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")).toEqual({
          kind: "declined",
          reason: "would_confirm"
        });
        expect(h.createPending).not.toHaveBeenCalled();
      } else await rejectAdmissionCard(h, h.gateway.callTool(h.token, tool.name, {}));
      expect(tool.execute).not.toHaveBeenCalled();
    }
  );

  it.each(["ordinary", "gate"] as const)(
    "missing runAutomatic fails closed even after a clean lookup (%s)",
    async (entry) => {
      const tool = admissionTool("settings.themeMode.set", { risk: "write" });
      const h = admissionFixture([tool], {
        deps: { provenance: { isTainted: async () => false, recordAdmission: async () => {} } }
      });
      if (entry === "gate") {
        expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")).toEqual({
          kind: "declined",
          reason: "would_confirm"
        });
      } else await rejectAdmissionCard(h, h.gateway.callTool(h.token, tool.name, {}));
      expect(tool.execute).not.toHaveBeenCalled();
    }
  );

  it.each(["ordinary", "gate"] as const)(
    "cleanup failure after dispatch never retries or raises a card (%s)",
    async (entry) => {
      const tool = admissionTool("settings.themeMode.set", { risk: "write" });
      const h = admissionFixture([tool]);
      h.runAutomatic.mockImplementation(async (_actor, _thread, callback) => {
        await callback();
        throw new Error("private cleanup detail");
      });
      const result =
        entry === "gate"
          ? await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")
          : await h.gateway.callTool(h.token, tool.name, {});
      expect(entry === "gate" && "response" in result ? result.response : result).toEqual(failure);
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(h.runAutomatic).toHaveBeenCalledOnce();
      expect(h.createPending).not.toHaveBeenCalled();
      expect(JSON.stringify({ result, records: h.records })).not.toContain(
        "private cleanup detail"
      );
    }
  );

  it.each(["ordinary", "gate"] as const)(
    "a throwing handler executes once and releases its guard (%s)",
    async (entry) => {
      const execute = vi.fn<ToolExecute>(async () => {
        throw new Error("private callback detail");
      });
      const tool = admissionTool("settings.themeMode.set", { risk: "write", execute });
      const h = admissionFixture([tool]);
      const result =
        entry === "gate"
          ? await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")
          : await h.gateway.callTool(h.token, tool.name, {});
      expect(entry === "gate" && "response" in result ? result.response : result).toEqual({
        ok: false,
        error: `Tool ${tool.name} failed`
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(h.events).toEqual(["claim", "release"]);
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );

  it("dry-run never acquires a reservation or records content", async () => {
    const tool = admissionTool("settings.themeMode.set", { risk: "write", content: "outside" });
    const h = admissionFixture([tool]);
    expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "dry-run")).toEqual({
      kind: "would_run",
      approvalMode: "yolo"
    });
    expect(h.runAutomatic).not.toHaveBeenCalled();
    expect(h.recordAdmission).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("protects outbound GET dispatch even though its effective risk is read", async () => {
    const tool = admissionTool("app.callAction", { risk: "write" });
    const h = admissionFixture([tool], {
      deps: {
        perCallResolvers: {
          [tool.name]: async () =>
            resolvedCall({ risk: "read", confirmWhenTainted: true, externalContent: true })
        }
      }
    });
    expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: true });
    expect(h.runAutomatic).toHaveBeenCalledExactlyOnceWith(
      "actor-a",
      "thread-a",
      expect.any(Function)
    );
    expect(h.events).toEqual(["claim", "release", "admit:app_action_outside"]);
  });
});
