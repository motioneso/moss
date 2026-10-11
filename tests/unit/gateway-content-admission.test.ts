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

const payload = {
  data: { value: "outside text that must not leak" },
  media: { kind: "image" as const, mimeType: "image/png", base64: "outside-image-bytes" }
};

describe("gateway content admission", () => {
  it.each([
    ["undeclared", { content: undefined }],
    ["outside", { content: "outside" }],
    ["external content", { content: "user_authored", externalContent: true }],
    ["external tool", { content: "user_authored", isExternal: true }]
  ] as const)("records %s reads before returning text or media", async (_label, overrides) => {
    const tool = admissionTool("example.read", { ...overrides, execute: async () => payload });
    const h = admissionFixture([tool]);
    const admission = deferred();
    h.recordAdmission.mockImplementation(async (actor, thread, path) => {
      expect([actor, thread, path]).toEqual(["actor-a", "thread-a", "tool_external_content"]);
      await admission.promise;
    });
    let exposed = false;
    const pending = h.gateway.callTool(h.token, tool.name, {}).then((result) => {
      exposed = true;
      return result;
    });
    await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce(), { interval: 1 });
    expect(exposed).toBe(false);
    admission.resolve();
    expect(await pending).toMatchObject({ ok: true, media: payload.media });
    expect(h.runAutomatic).not.toHaveBeenCalled();
  });

  it.each([
    ["app.callAction", "app_action_outside"],
    ["chat.readAttachment", "attachment_read"],
    ["chat.listTodaysTurns", "tool_external_content"]
  ])("records the correct path for %s", async (name, path) => {
    const h = admissionFixture([admissionTool(name, { content: "outside" })]);
    expect(await h.gateway.callTool(h.token, name, {})).toMatchObject({ ok: true });
    expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith("actor-a", "thread-a", path);
  });

  it.each(["ordinary", "gate", "confirmed"] as const)(
    "withholds all outside text, raw data and media after failed admission (%s)",
    async (entry) => {
      const tool = admissionTool("example.read", {
        risk: entry === "confirmed" ? "outbound" : "read",
        ...(entry === "confirmed"
          ? {
              actionLabel: "Read example",
              approvalContent: "user_authored" as const,
              approvalPresentation: async () => ({ target: "Example", fields: [] })
            }
          : {}),
        content: "outside",
        execute: async () => payload
      });
      const h = admissionFixture([tool]);
      h.state.tainted = entry === "confirmed";
      h.recordAdmission.mockRejectedValue(new Error("private database detail"));
      const pending =
        entry === "gate"
          ? h.gateway.callToolForGate(h.token, tool.name, {}, "execute")
          : h.gateway.callTool(h.token, tool.name, {});
      if (entry === "confirmed") {
        await vi.waitFor(
          () => expect(h.records.some((r) => r.kind === "action_request")).toBe(true),
          { interval: 1 }
        );
        h.confirmations.resolve("action-1", "confirmed");
      }
      const result = await pending;
      expect(entry === "gate" && "response" in result ? result.response : result).toEqual({
        ok: false,
        error: CONTEXT_ADMISSION_UNAVAILABLE
      });
      const visible = JSON.stringify({ result, records: h.records });
      expect(visible).not.toContain(payload.data.value);
      expect(visible).not.toContain(payload.media.base64);
      expect(visible).not.toContain("private database detail");
      expect(visible).not.toContain("structuredData");
      expect(visible).not.toContain('"media"');
    }
  );

  it.each([
    ["missing port", { deps: { provenance: undefined } }],
    ["missing thread", { threadId: null }],
    ["foreign thread", { threadId: "foreign-thread" }]
  ] as const)("does not expose outside reads with %s", async (_label, options) => {
    const tool = admissionTool("example.read", {
      content: "outside",
      execute: async () => payload
    });
    const h = admissionFixture([tool], options);
    expect(await h.gateway.callTool(h.token, tool.name, {})).toEqual({
      ok: false,
      error: CONTEXT_ADMISSION_UNAVAILABLE
    });
  });

  it.each(["app.findAction", "app.readSource", "app.getMapSlice", "settings.get"])(
    "keeps declared user-authored %s results clean without provenance",
    async (name) => {
      const h = admissionFixture([admissionTool(name)], { deps: { provenance: undefined } });
      expect(await h.gateway.callTool(h.token, name, {})).toMatchObject({ ok: true });
      expect(h.recordAdmission).not.toHaveBeenCalled();
    }
  );

  it("does not record a thrown handler that returned no outside result", async () => {
    const tool = admissionTool("example.read", {
      content: "outside",
      execute: async () => {
        throw new Error("private handler detail");
      }
    });
    const h = admissionFixture([tool]);
    expect(await h.gateway.callTool(h.token, tool.name, {})).toEqual({
      ok: false,
      error: `Tool ${tool.name} failed`
    });
    expect(h.recordAdmission).not.toHaveBeenCalled();
  });

  it("keeps a module-reported failure containing outside content behind admission", async () => {
    const tool = admissionTool("example.read", {
      content: "outside",
      execute: async () => ({ data: { status: "error", value: payload.data.value } })
    });
    const h = admissionFixture([tool]);
    h.recordAdmission.mockRejectedValue(new Error("unavailable"));
    expect(await h.gateway.callTool(h.token, tool.name, {})).toEqual({
      ok: false,
      error: CONTEXT_ADMISSION_UNAVAILABLE
    });
    expect(h.recordAdmission).toHaveBeenCalledOnce();
  });
});

describe("content determines later app-action policy", () => {
  it.each([false, true])(
    "outside reads force app writes and outbound GET approval unless YOLO trusts the write (YOLO=%s)",
    async (yolo) => {
      for (const outboundGet of [false, true]) {
        const read = admissionTool("example.read", { content: "outside" });
        const write = admissionTool("app.callAction", {
          risk: "write",
          content: "outside",
          externalContent: true
        });
        const h = admissionFixture([read, write], {
          deps: {
            yoloMode: async () => yolo,
            perCallResolvers: {
              "app.callAction": async () =>
                resolvedCall(
                  outboundGet
                    ? { risk: "read", confirmWhenTainted: true, externalContent: true }
                    : {}
                )
            }
          }
        });
        expect(await h.gateway.callTool(h.token, read.name, {})).toMatchObject({ ok: true });
        if (yolo && !outboundGet) {
          expect(await h.gateway.callTool(h.token, write.name, {})).toMatchObject({ ok: true });
          expect(write.execute).toHaveBeenCalledOnce();
          expect(h.createPending).not.toHaveBeenCalled();
          continue;
        }
        await rejectAdmissionCard(h, h.gateway.callTool(h.token, write.name, {}));
        expect(write.execute).not.toHaveBeenCalled();
        expect(h.records).toContainEqual(
          expect.objectContaining({ kind: "action_request", outsideContentNotice: true })
        );
      }
    }
  );

  it.each(["ask_each_time", "trusted_auto"] as const)(
    "a dedicated write keeps the user's family tier after outside content (%s)",
    async (tier) => {
      const read = admissionTool("example.read", { content: "outside" });
      const write = admissionTool("settings.themeMode.set", { risk: "write" });
      const h = admissionFixture([read, write], {
        deps: {
          yoloMode: async () => false,
          actionPolicy: () => ({
            getFamilyTier: async () => tier,
            getFamilyManifest: async () => ({
              id: "change",
              label: "Change",
              description: "Change settings",
              defaultTier: "ask_each_time" as const,
              allowedTiers: ["ask_each_time" as const, "trusted_auto" as const]
            })
          })
        }
      });
      await h.gateway.callTool(h.token, read.name, {});
      expect(h.state.tainted).toBe(true);
      if (tier === "trusted_auto") {
        expect(await h.gateway.callTool(h.token, write.name, {})).toMatchObject({ ok: true });
        expect(write.execute).toHaveBeenCalledOnce();
        expect(h.runAutomatic).not.toHaveBeenCalled();
      } else {
        await rejectAdmissionCard(h, h.gateway.callTool(h.token, write.name, {}));
        expect(write.execute).not.toHaveBeenCalled();
      }
    }
  );

  it("per-call user-authored content overrides static app.callAction outside content", async () => {
    const app = admissionTool("app.callAction", {
      risk: "write",
      content: "outside",
      externalContent: true
    });
    const theme = admissionTool("settings.themeMode.set", { risk: "write" });
    const h = admissionFixture([app, theme], {
      deps: { perCallResolvers: { [app.name]: async () => resolvedCall() } }
    });
    expect(await h.gateway.callTool(h.token, app.name, {})).toMatchObject({ ok: true });
    expect(await h.gateway.callTool(h.token, theme.name, {})).toMatchObject({ ok: true });
    expect(h.recordAdmission).not.toHaveBeenCalled();
    expect(h.state.tainted).toBe(false);
    expect(h.runAutomatic).toHaveBeenCalledTimes(2);
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("per-call outside content overrides a user-authored static action", async () => {
    const app = admissionTool("app.callAction", { risk: "write" });
    const h = admissionFixture([app], {
      deps: {
        perCallResolvers: { [app.name]: async () => resolvedCall({ externalContent: true }) }
      }
    });
    expect(await h.gateway.callTool(h.token, app.name, {})).toMatchObject({ ok: true });
    expect(h.events).toEqual(["claim", "release", "admit:app_action_outside"]);
  });

  it("binds cross-tool reads to the submitted thread and defers admission to the normalized chat block", async () => {
    const execute = vi.fn<ToolExecute>(async () => ({ data: { chunks: [] } }));
    const read = admissionTool("notes.search", { content: "outside", execute });
    const h = admissionFixture([read]);
    expect(
      await h.gateway.runReadToolForActor(
        "actor-a",
        read.name,
        {},
        { threadId: "thread-a", chatSessionId: "actor-a:chat" }
      )
    ).toMatchObject({ ok: true });
    expect(execute.mock.calls[0]?.[2]).toMatchObject({
      actorUserId: "actor-a",
      threadId: "thread-a",
      chatSessionId: "actor-a:chat"
    });
    expect(h.recordAdmission).not.toHaveBeenCalled();
  });
});
