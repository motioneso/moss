import { AcpPromptFailureError } from "@moss/acp";
import { describe, expect, it } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { mapRpcError } from "../../packages/chat/src/live/chat-engine-rpc-client.js";
import { ChatEngineReadError } from "../../packages/chat/src/live/errors.js";
import { FakeEngine, rejectingDeps } from "./chat-session-manager.test.js";

describe("ChatSessionManager readNew failures", () => {
  it("keeps safe readNew failure metadata without retaining the raw cause", async () => {
    const cause = mapRpcError(
      "internal",
      "429 rate limit while handling PRIVATE_CHAT_PROMPT_CANARY",
      429
    );
    class RejectingReadEngine extends FakeEngine {
      override async readNew(): Promise<never> {
        throw cause;
      }
    }

    const manager = new ChatSessionManager(rejectingDeps(new RejectingReadEngine()));
    const failure = await manager.submitTurn("u1", "Ben", "first").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatEngineReadError);
    expect(failure).toMatchObject({
      message: "readNew failed",
      diagnostic: {
        source: "engine.readNew",
        provider: "anthropic",
        classification: "rate_limited",
        rpcCode: "internal",
        statusCode: 429
      }
    });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify((failure as ChatEngineReadError).diagnostic)).not.toContain(
      "PRIVATE_CHAT_PROMPT_CANARY"
    );
  });

  it("preserves the safe ACP prompt failure stage through runTurn", async () => {
    class RejectingReadEngine extends FakeEngine {
      override async readNew(): Promise<never> {
        throw new AcpPromptFailureError("acp_prompt_rejected", -32003);
      }
    }

    const manager = new ChatSessionManager(rejectingDeps(new RejectingReadEngine()));
    const failure = await manager.submitTurn("u1", "Ben", "first").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatEngineReadError);
    expect(failure).toMatchObject({
      message: "readNew failed",
      diagnostic: {
        source: "engine.readNew",
        provider: "anthropic",
        classification: "upstream_error",
        failureStage: "acp_prompt_rejected",
        acpCode: -32003
      }
    });
    expect(failure).not.toHaveProperty("cause");
  });
});
