import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  readStoredVisual,
  validateVisualCatalogReply,
  visualReplyText,
  VISUAL_CATALOG_VERSION
} from "@moss/shared";
import { listChatThreadMessagesResponseSchema } from "@moss/shared";
import { VisualPresentationService } from "../packages/chat/src/visual/presentation-service.js";
import { promptVisualFields } from "../packages/chat/src/visual/user-data.js";
import { serializeMessage } from "../packages/chat/src/route-serializers.js";
import { parseRecord, recordsFromMessages } from "../apps/web/src/chat/use-chat-stream.js";
import {
  applyStreamRecord,
  mergeHydratedRecords
} from "../apps/web/src/chat/stream-record-identity.js";
import { chatExportText } from "../packages/settings/src/chat-export-text.js";
import { prepareOpenUiModule } from "../apps/web/openui-runtime.js";

function fixture() {
  const service = new VisualPresentationService();
  const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
  const turn = service.begin("session", identity);
  const context = turn.registerPrompt(
    'Show my data:\n```json\n{"hours":6,"project":"Garden","done":false}\n```',
    "2026-10-23T12:00:00Z"
  );
  const input = JSON.parse(context.split("Worked tool input: ")[1]!).proposal;
  const result = service.present(
    { ...identity, chatSessionId: "session", requestId: "test" },
    input
  );
  if (!result.ok) throw new Error(result.code);
  return structuredClone(result.reply);
}

describe("installed visual catalog boundaries", () => {
  it("captures exact fields from the original prompt, including false and null", () => {
    expect(promptVisualFields('{"done":false,"hours":0,"unknown":null}')).toEqual({
      done: false,
      hours: 0,
      unknown: null
    });
    expect(promptVisualFields("not json")).toEqual({ text: "not json" });
    expect(fixture().catalogVersion).toBe(VISUAL_CATALOG_VERSION);
  });

  it.each([
    'root = Reply([Section("A", [Fact("REF", "hours")])]); trailing',
    'root = Reply([Section("A", [Fact("REF", "hours")])]); alert("x")',
    'root = Reply([Section("A", [Fact("REF", "missing")])]);',
    'root = Reply([Section("A", [Fact("REF", "toString")])]);',
    'root = Reply([Section("A", [Fact("REF", "hours"), Fact("REF", "hours"), Fact("REF", "hours"), Fact("REF", "hours")])]);',
    'root = Reply([Section("A", [Section("Nested", [])])]);',
    'root = Reply([Section("A", [Fact("forged", "hours")])]);',
    'root = Reply([Section("A", [Fact("REF", "hours")])]',
    'root = Reply([Section("A", [Fact("REF", "hours", "invented")])]);'
  ])("rejects unsupported or recovered syntax and bad bindings: %s", (program) => {
    const reply = fixture();
    reply.blocks[0]!.program = program.replaceAll("REF", reply.snapshots[0]!.ref);
    expect(validateVisualCatalogReply(reply).ok).toBe(false);
    expect(readStoredVisual(reply)).toEqual({ visualFallbackText: reply.fallbackText });
  });

  it("rejects unknown catalogs, source authority, structured fields and unused snapshots", () => {
    const reply = fixture();
    expect(validateVisualCatalogReply({ ...reply, catalogVersion: "future" }).ok).toBe(false);
    reply.snapshots[0]!.origin = "source";
    expect(validateVisualCatalogReply(reply).ok).toBe(false);
    reply.snapshots[0]!.origin = "user";
    reply.snapshots[0]!.fields.hours = [6];
    expect(validateVisualCatalogReply(reply).ok).toBe(false);
  });

  it("survives real response serialization, history hydration and saved-identity replacement", async () => {
    const reply = fixture();
    const dto = serializeMessage({
      id: "message",
      thread_id: "thread",
      owner_user_id: "actor",
      role: "assistant",
      status: "stored",
      body: "Six hours.",
      created_at: new Date(),
      updated_at: new Date(),
      tool_metadata: { visualReplyV1: reply, turnId: "turn" },
      model_metadata: {}
    } as never);
    const app = Fastify();
    app.get(
      "/history",
      { schema: { response: { 200: listChatThreadMessagesResponseSchema } } },
      () => ({ messages: [dto] })
    );
    try {
      const response = await app.inject({ method: "GET", url: "/history" });
      expect(response.statusCode, response.body).toBe(200);
      const messages = response.json().messages;
      expect(messages[0].visualReply).toEqual(reply);
      const history = recordsFromMessages(messages);
      expect(mergeHydratedRecords([], history)[0]?.visualReply).toEqual(reply);
      const record = parseRecord(
        JSON.stringify({
          kind: "reply",
          text: dto.body,
          messageId: "message",
          turnId: "turn",
          visualReply: reply
        })
      )!;
      const records = applyStreamRecord(
        [
          { kind: "reply", text: "draft", turnId: "other" },
          { kind: "reply", text: "draft", turnId: "turn" }
        ],
        record
      );
      expect(records).toHaveLength(2);
      expect(records[0]?.turnId).toBe("other");
      expect(records[1]?.visualReply).toEqual(reply);
      expect(parseRecord(JSON.stringify({ ...record, kind: "user" }))?.visualReply).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("uses readable compatibility text in copy and portable exports", () => {
    const reply = fixture();
    const exported = chatExportText({
      body: "Six hours.",
      toolMetadata: { visualReplyV1: JSON.parse(JSON.stringify(reply)), turnId: "turn" }
    });
    expect(exported.body).toBe(visualReplyText("Six hours.", reply.fallbackText));
    expect(JSON.stringify(exported)).not.toContain("root =");
    expect(exported.toolMetadata).toEqual({ turnId: "turn" });
    expect(readStoredVisual({ ...reply, version: 2 })).toEqual({
      visualFallbackText: reply.fallbackText
    });
  });

  it("adapts dev query ids and refuses a changed upstream bootstrap", () => {
    const source =
      'process.env["NODE_ENV"];\n//#region src/devtoolsBootstrap.ts\nstartDevtools();\n//#endregion';
    expect(
      prepareOpenUiModule(
        source,
        "/node_modules/@openuidev/react-lang/dist/index.mjs?v=1",
        "development"
      )
    ).toBe('"development";\n// Moss: automatic devtools bootstrap removed.\n');
    expect(() =>
      prepareOpenUiModule(
        "changed",
        "/node_modules/@openuidev/react-lang/dist/index.mjs",
        "production"
      )
    ).toThrow("bootstrap changed");
  });
});
