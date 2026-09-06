import { randomUUID } from "node:crypto";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import { AiRepository } from "../repository.js";
import type { AssistantToolGateway } from "./gateway.js";

/**
 * Action resolver for a gateway that has no confirmation bridge wired: confirmations fail
 * with 503, dismissals still resolve the pending action row so it does not linger.
 */
export function createUnwiredActionResolver(deps: {
  readonly runner: DataContextRunner;
  readonly repository?: AiRepository;
}): AssistantToolGateway["resolveActionRequest"] {
  const repository = deps.repository ?? new AiRepository();
  return async (actorUserId, actionRequestId, status) => {
    if (status === "confirmed") {
      throw new HttpError(503, "Assistant action resolution is not available");
    }

    const access: AccessContext = { actorUserId, requestId: `unwired_${randomUUID()}` };
    const resolved = await deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
      repository.resolveAssistantAction(scopedDb, actionRequestId, { status })
    );
    return resolved ? "resolved" : "not_found";
  };
}
