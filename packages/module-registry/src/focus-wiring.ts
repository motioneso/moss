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
 * The judge is the admin's sorting model (Ben, 2026-09-22) and is never defaulted: with no sorting
 * model bound, `hasJudgeModel` is false and nothing is judged. Each call re-reads the binding and
 * runs on exactly that model, so a change in Settings takes effect on the next judgment.
 */
export function createFocusJudgmentService(deps: FocusWiringDeps): FocusJudgmentService {
  const repository = new AiRepository();
  const cipher = createAiSecretCipher();
  const generate = deps.generate ?? generateStructured;
  const choose = deps.choose ?? generateChoices;

  const ports: FocusPorts = {
    currentBlock: (scopedDb, now) => getCurrentMossBlock(scopedDb, now),
    inQuietHours: (scopedDb, now) => isActorInQuietHours(scopedDb, quietHoursPortImpl, now),
    hasJudgeModel: async (scopedDb) => (await repository.resolveFocusJudgeModel(scopedDb)) !== null,
    generate: async (scopedDb, input) => {
      const model = await repository.resolveFocusJudgeModel(scopedDb);
      if (!model) return { ok: false, error: "needs_config" };
      const result = await generate(
        scopedDb,
        {
          service: input.service,
          schema: input.schema,
          prompt: input.prompt,
          requireExplicitBinding: input.requireExplicitBinding,
          maxOutputTokens: input.maxOutputTokens,
          explicitModel: model,
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
    choose: async (scopedDb, input) => {
      const model = await repository.resolveFocusJudgeModel(scopedDb);
      if (!model) return { ok: false, error: "needs_config" };
      return choose(
        scopedDb,
        { ...input, explicitModel: model },
        { repository, cipher, logger: deps.logger }
      );
    },
    logger: deps.logger
  };

  return buildFocusJudgmentService(ports);
}
