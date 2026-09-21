import type { FastifyBaseLogger } from "fastify";

import {
  AiRepository,
  createAiSecretCipher,
  generateChoices,
  generateStructured,
  type ProviderKind,
  type StructuredProviderAdapter
} from "@moss/ai";
import { getCurrentMossBlock } from "@moss/calendar";
import {
  buildFocusJudgmentService,
  FOCUS_JUDGE_SERVICE_KEY,
  type FocusJudgmentService,
  type FocusPorts
} from "@moss/focus-judgment";
import { isActorInQuietHours } from "@moss/notifications";

import { quietHoursPortImpl } from "./built-in-module-helpers.js";

export {
  FOCUS_JUDGE_TIMEOUT_MS,
  FocusError,
  type FocusJudgmentService
} from "@moss/focus-judgment";

export interface FocusWiringDeps {
  readonly logger: Pick<FastifyBaseLogger, "info" | "warn">;
  readonly createCliStructuredAdapter?: (kind: ProviderKind) => StructuredProviderAdapter;
  /** TEST-ONLY. Replaces the real structured model call so tests never reach a provider. */
  readonly generate?: typeof generateStructured;
  /** TEST-ONLY. Replaces the real choice call so tests never reach a provider. */
  readonly choose?: typeof generateChoices;
}

/**
 * The Trail Marker focus judgment is platform code, not a module, and the API app does not import
 * module packages itself. This composition root joins the pieces it needs: the calendar's public
 * "block that is on now" read, the notifications module's plain quiet-hours check, and the
 * structured model call.
 *
 * The judgment model is never defaulted. `hasJudgeModel` is true only when an admin has bound this
 * exact service key to a model; reading the binding first also avoids the router's "needs
 * configuration" error row that a lookup of an unbound key would write on every poll.
 */
export function createFocusJudgmentService(deps: FocusWiringDeps): FocusJudgmentService {
  const repository = new AiRepository();
  const cipher = createAiSecretCipher();
  const generate = deps.generate ?? generateStructured;
  const choose = deps.choose ?? generateChoices;

  const ports: FocusPorts = {
    currentBlock: (scopedDb, now) => getCurrentMossBlock(scopedDb, now),
    inQuietHours: (scopedDb, now) => isActorInQuietHours(scopedDb, quietHoursPortImpl, now),
    hasJudgeModel: async (scopedDb) => {
      const bindings = await repository.listModuleServiceBindings(scopedDb);
      if (bindings[FOCUS_JUDGE_SERVICE_KEY]?.kind !== "model") return false;
      const resolved = await repository.resolveModelForService(scopedDb, FOCUS_JUDGE_SERVICE_KEY, {
        capability: "json",
        requireExplicitBinding: true
      });
      return resolved.model !== null;
    },
    generate: async (scopedDb, input) => {
      const result = await generate(
        scopedDb,
        {
          service: input.service,
          schema: input.schema,
          prompt: input.prompt,
          requireExplicitBinding: input.requireExplicitBinding,
          maxOutputTokens: input.maxOutputTokens,
          signal: input.signal
        },
        {
          repository,
          cipher,
          logger: deps.logger,
          createCliStructuredAdapter: deps.createCliStructuredAdapter
        }
      );
      return result.ok ? { ok: true, object: result.object } : { ok: false, error: result.error };
    },
    choose: (scopedDb, input) =>
      choose(scopedDb, input, { repository, cipher, logger: deps.logger }),
    logger: deps.logger
  };

  return buildFocusJudgmentService(ports);
}
