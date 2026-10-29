import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { listChatThreadMessagesResponseSchema } from "../../packages/shared/src/chat-api.js";

describe("chat history response schema", () => {
  it("keeps the mute result on a saved action record", async () => {
    const app = Fastify();
    const mute = { id: "m1", label: "Gym", scope: "topic", createdAt: "2026-10-29T00:00:00.000Z" };
    app.get(
      "/messages",
      { schema: { response: { 200: listChatThreadMessagesResponseSchema } } },
      async () => ({
        messages: [
          {
            id: "a",
            threadId: "t",
            ownerUserId: "u",
            role: "assistant",
            status: "stored",
            body: "Done",
            modelRoute: null,
            tools: [],
            createdAt: "2026-10-29T00:00:00.000Z",
            updatedAt: "2026-10-29T00:00:00.000Z",
            activity: [
              {
                kind: "action_result",
                text: "Executed: chat.heartbeatMute",
                toolName: "chat.heartbeatMute",
                outcome: "executed",
                result: { status: "muted", mute }
              }
            ]
          }
        ]
      })
    );
    const body = (await app.inject("/messages")).json();
    expect(body.messages[0].activity[0].result).toEqual({ status: "muted", mute });
    await app.close();
  });
});
