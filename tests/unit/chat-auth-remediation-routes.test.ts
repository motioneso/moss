import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerChatRoutes } from "../../packages/chat/src/routes.js";
import { registerChatLiveRoutes } from "../../packages/chat/src/live-routes.js";
import { PageContextStore } from "../../packages/chat/src/live/page-context-store.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import {
  CODEX_SIGN_IN_REQUIRED_MESSAGE,
  knownAuthFailureMessage
} from "../../packages/chat/src/live/auth-errors.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_SIGN_IN_EXPIRED_MESSAGE =
  "The Claude sign-in has expired; an admin can log it in again under Settings, Assistant & AI";

const AUTH_MESSAGES = [CODEX_SIGN_IN_REQUIRED_MESSAGE, CLAUDE_SIGN_IN_EXPIRED_MESSAGE] as const;
type InjectRequest = { method: string; url: string; payload?: unknown };
type InjectResponse = { statusCode: number; json: () => unknown };

function buildLiveApp(error: Error): FastifyInstance {
  const app = Fastify({ logger: false });
  registerChatLiveRoutes(app, {
    resolveAccessContext: async () => ({ actorUserId: ACTOR_ID, requestId: "test-request" }),
    runtime: {
      manager: {
        submitTurn: async () => {
          throw error;
        }
      },
      resolveUserName: async () => "Test User"
    } as never,
    pageContextStore: new PageContextStore({ now: () => Date.now(), ttlMs: 300_000 })
  });
  return app;
}

function buildRestApp(error: Error): FastifyInstance {
  const app = Fastify({ logger: false });
  registerChatRoutes(app, {
    rootDb: {} as never,
    resolveAccessContext: async () => ({ actorUserId: ACTOR_ID, requestId: "test-request" }),
    dataContext: {
      withDataContext: async () => {
        throw error;
      }
    } as never,
    chatEngineFactory: (() => {
      throw new Error("chat engine should not be reached");
    }) as never
  });
  return app;
}

async function assertSerializedError(
  app: FastifyInstance,
  request: InjectRequest,
  expectedStatus: number,
  expectedMessage: string
): Promise<void> {
  await app.ready();
  const response = await (app.inject(request as never) as unknown as Promise<InjectResponse>);
  expect(response.statusCode).toBe(expectedStatus);
  expect(response.json()).toEqual({ error: expectedMessage });
}

describe("chat auth remediation route boundaries", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each(AUTH_MESSAGES)("live route preserves fixed auth message: %s", async (message) => {
    const app = buildLiveApp(new CliChatUnavailableError(message));
    apps.push(app);
    await assertSerializedError(
      app,
      { method: "POST", url: "/api/chat/turn", payload: { text: "hello" } },
      503,
      message
    );
  });

  it.each(AUTH_MESSAGES)("REST route preserves fixed auth message: %s", async (message) => {
    const app = buildRestApp(new CliChatUnavailableError(message));
    apps.push(app);
    await assertSerializedError(app, { method: "GET", url: "/api/chat/threads" }, 503, message);
  });

  it.each([
    `${CODEX_SIGN_IN_REQUIRED_MESSAGE} bearer sk-live-secret`,
    "provider failed password=secret"
  ])("live route keeps non-allowlisted auth text generic: %s", async (message) => {
    const app = buildLiveApp(new CliChatUnavailableError(message));
    apps.push(app);
    await assertSerializedError(
      app,
      { method: "POST", url: "/api/chat/turn", payload: { text: "hello" } },
      503,
      "Live chat is currently unavailable on this host."
    );
  });

  it.each([
    `${CODEX_SIGN_IN_REQUIRED_MESSAGE} bearer sk-live-secret`,
    "provider failed password=secret"
  ])("REST route keeps non-allowlisted auth text generic: %s", async (message) => {
    const app = buildRestApp(new CliChatUnavailableError(message));
    apps.push(app);
    await assertSerializedError(
      app,
      { method: "GET", url: "/api/chat/threads" },
      503,
      "Live chat is currently unavailable on this host."
    );
  });

  it("uses exact matching for the auth allowlist", () => {
    expect(knownAuthFailureMessage(CODEX_SIGN_IN_REQUIRED_MESSAGE)).toBe(
      CODEX_SIGN_IN_REQUIRED_MESSAGE
    );
    expect(knownAuthFailureMessage(`${CODEX_SIGN_IN_REQUIRED_MESSAGE} secret`)).toBeUndefined();
  });
});
