import type { FastifyReply } from "fastify";
import { handleRouteError as handleModuleRouteError } from "@moss/module-sdk";
import { CliChatUnavailableError } from "./live/errors.js";
import { knownAuthFailureMessage } from "./live/auth-errors.js";
import { CLI_VERSION_TOO_OLD_MESSAGE, notifyCliVersionTooOld } from "./live/cli-version-errors.js";
import { CONVERSATION_RESUME_MESSAGES } from "./live/summary-coverage.js";

export function handleRouteError(error: unknown, reply: FastifyReply) {
  if (error instanceof CliChatUnavailableError) {
    const authMessage = knownAuthFailureMessage(error.message);
    if (authMessage) {
      return reply.code(503).send({ error: authMessage });
    }
    if (error.message === CLI_VERSION_TOO_OLD_MESSAGE) {
      notifyCliVersionTooOld();
      return reply.code(503).send({ error: CLI_VERSION_TOO_OLD_MESSAGE });
    }
    if (CONVERSATION_RESUME_MESSAGES.has(error.message)) {
      return reply.code(503).send({ error: error.message });
    }
    reply.log?.warn?.({ err: error }, "live chat unavailable");
    return reply.code(503).send({ error: "Live chat is currently unavailable on this host." });
  }
  return handleModuleRouteError(error, reply, { invalidRequestMessage: "Chat request is invalid" });
}
