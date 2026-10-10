import { describe, expect, it, vi } from "vitest";
import type { ModuleAssistantToolManifest, ToolExecute } from "@moss/module-sdk";

import {
  admissionFixture,
  admissionTool,
  resolvedCall
} from "./helpers/gateway-admission-fixture.js";

const outcomes = ["success", "handler_error", "module_error"] as const;

describe("unattended action outcome titles", () => {
  it.each(outcomes)(
    "freezes an ordinary tool title before %s in auto and YOLO mode",
    async (outcome) => {
      for (const yolo of [false, true]) {
        const order: string[] = [];
        const summarize = vi.fn((input: Record<string, unknown>) => {
          order.push("summary");
          return `Rename ${String(input.title)}`;
        });
        const execute = vi.fn<ToolExecute>(async (_db, input) => {
          order.push("execute");
          input.title = "a different meeting after execution";
          if (outcome === "handler_error") throw new Error("private handler failure");
          return { data: { status: outcome === "module_error" ? "error" : "ok" } };
        });
        const tool = admissionTool("calendar.renameMeeting", {
          risk: "write",
          summarize,
          execute,
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
          affectsQueryKeys: ["calendar.events"]
        });
        const h = admissionFixture([tool], { deps: { yoloMode: async () => yolo } });
        await h.gateway.callTool(h.token, tool.name, { title: "your morning meeting" });

        expect(order).toEqual(["summary", "execute"]);
        expect(summarize).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledOnce();
        expect(h.createPending).not.toHaveBeenCalled();
        expect(h.records).toHaveLength(1);
        expect(h.records[0]).toMatchObject({
          kind: "action_result",
          summary: "Rename your morning meeting",
          outcome: outcome === "success" ? "executed" : "error",
          decidedBy: "policy"
        });
        if (outcome === "success") {
          expect(h.records[0]).toHaveProperty("affectsQueryKeys", ["calendar.events"]);
        } else {
          expect(h.records[0]).not.toHaveProperty("affectsQueryKeys");
        }
        expect(h.audit).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            approvalMode: yolo ? "yolo" : "auto",
            outcome: outcome === "success" ? "success" : "failed"
          })
        );
      }
    }
  );

  it("reports the owning module as affected for a write tool with no per-call resolution", async () => {
    const tool = admissionTool("example.logMeal", { risk: "write" });
    const h = admissionFixture([tool]);
    await h.gateway.callTool(h.token, tool.name, {});
    expect(h.records[0]).toMatchObject({ kind: "action_result", outcome: "executed" });
    expect(h.records[0]).toHaveProperty("affectsModules", ["example"]);
  });

  it.each(outcomes)("retains a resolved app-action title on unattended %s", async (outcome) => {
    const resolution = resolvedCall({ summary: "Change your preferred theme" });
    const execute = vi.fn<ToolExecute>(async () => {
      Object.assign(resolution, { summary: "A changed resolution after execution" });
      if (outcome === "handler_error") throw new Error("private failure");
      return { data: { status: outcome === "module_error" ? "error" : "ok" } };
    });
    const tool = admissionTool("app.callAction", { risk: "write", execute });
    const h = admissionFixture([tool], {
      deps: { perCallResolvers: { [tool.name]: async () => resolution } }
    });
    await h.gateway.callTool(h.token, tool.name, {});
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      kind: "action_result",
      summary: "Change your preferred theme",
      outcome: outcome === "success" ? "executed" : "error",
      decidedBy: "policy"
    });
    expect(execute).toHaveBeenCalledOnce();
    if (outcome === "success") {
      expect(h.records[0]).toHaveProperty("affectsModules", ["settings"]);
    } else {
      expect(h.records[0]).not.toHaveProperty("affectsModules");
    }
  });

  it.each(outcomes)("retains title through the classifier gateway on %s", async (outcome) => {
    const tool = admissionTool("calendar.renameMeeting", {
      risk: "write",
      actionLabel: "Rename your meeting",
      execute: vi.fn(async () => {
        if (outcome === "handler_error") throw new Error("private failure");
        return { data: { status: outcome === "module_error" ? "error" : "ok" } };
      })
    });
    const h = admissionFixture([tool]);
    expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "dry-run")).toMatchObject({
      kind: "would_run"
    });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(h.records).toEqual([]);
    expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "execute")).toMatchObject({
      kind: "executed"
    });
    expect(h.records[0]).toMatchObject({
      summary: "Rename your meeting",
      decidedBy: "policy",
      outcome: outcome === "success" ? "executed" : "error"
    });
  });

  it.each([
    {},
    { summarize: () => "calendar.renameMeeting" },
    { summarize: () => "Run /private/script.sh" },
    {
      summarize: () => {
        throw new Error("private summary failure");
      }
    }
  ] satisfies Partial<ModuleAssistantToolManifest>[])(
    "does not invent a title or block dispatch when presentation is unavailable: %s",
    async (presentation) => {
      const tool = admissionTool("calendar.renameMeeting", {
        risk: "write",
        actionLabel: undefined,
        approvalPresentation: undefined,
        ...presentation
      });
      const h = admissionFixture([tool]);
      expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: true });
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(h.records[0]).toMatchObject({ outcome: "executed", decidedBy: "policy" });
      expect(h.records[0]).not.toHaveProperty("summary");
    }
  );

  it("keeps ordinary reads silent without adding an action-result row", async () => {
    const tool = admissionTool("calendar.listEvents", { actionLabel: "Read your events" });
    const h = admissionFixture([tool]);
    expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: true });
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(h.records).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses a plain explicit fallback label (summary throws: %s)",
    async (throws) => {
      const tool = admissionTool("notes.edit", {
        risk: "write",
        actionLabel: "Edit note",
        summarize: () => {
          if (throws) throw new Error("private summary failure");
          return "Edit note projects/plans.md.";
        }
      });
      const h = admissionFixture([tool]);
      expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: true });
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(h.records[0]).toMatchObject({
        summary: "Edit note",
        outcome: "executed",
        decidedBy: "policy"
      });
    }
  );
});
