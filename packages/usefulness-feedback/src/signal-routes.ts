import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import { createUsefulnessFeedbackSignalRouteSchema } from "@moss/shared";

import { serializeFeedback } from "./feedback-response.js";
import { sanitizeFeedbackMetadata } from "./metadata.js";
import { parseSignalBody } from "./request-parsing.js";
import type { UsefulnessFeedbackRepository } from "./repository.js";
import { verifyFeedbackTarget, type FeedbackTargetVerifierRegistry } from "./target-verifiers.js";

interface SignalRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly registry: FeedbackTargetVerifierRegistry;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: Pick<UsefulnessFeedbackRepository, "findActive" | "create">;
}

/** The app-action route has no cleanup, card, memory, provider or refresh dependencies. */
export function registerUsefulnessFeedbackSignalRoutes(
  server: FastifyInstance,
  dependencies: SignalRoutesDependencies
): void {
  server.post(
    "/api/me/usefulness-feedback/signals",
    // Parse the original body so unknown keys are rejected, not silently removed by AJV.
    { schema: { response: createUsefulnessFeedbackSignalRouteSchema.response } },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const input = parseSignalBody(request.body);
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const existing = await dependencies.repository.findActive(
            scopedDb,
            access.actorUserId,
            input.targetKind,
            input.targetRef,
            input.kind
          );
          if (existing) return { feedback: existing, created: false };

          const verification = await verifyFeedbackTarget(dependencies.registry, scopedDb, {
            actorUserId: access.actorUserId,
            targetKind: input.targetKind,
            targetRef: input.targetRef,
            surface: input.surface
          });
          return {
            feedback: await dependencies.repository.create(scopedDb, {
              ...input,
              ownerUserId: access.actorUserId,
              verification,
              metadata: sanitizeFeedbackMetadata(verification.metadata)
            }),
            created: true
          };
        });
        return reply
          .code(result.created ? 201 : 200)
          .send({ feedback: serializeFeedback(result.feedback) });
      } catch (error) {
        return handleRouteError(error, reply, {
          invalidRequestMessage: "Usefulness feedback request is invalid"
        });
      }
    }
  );
}
