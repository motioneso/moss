// external-modules/food/src/estimator/run.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 5): the ONE function that turns a
// meal description into an EstimatorOutcome. Called from two places (both
// outside this file's ownership): synchronously from the food.meals.log
// tool (Fork A, plan §2 — estimate inline so a typed meal gets a real
// estimate in the same request) and from this module's own queue handler
// (worker.ts's estimate.run, the manual-run retry path — no module handler
// can enqueue a job itself; worker-rpc-host.ts dispatches only
// attachments/notify/fetch/embed/db/ai/auth/kv, per team-lead correction).
//
// The two callers do NOT share a context type — the tool path's context is
// a different object from @moss/module-sdk/worker's ModuleWorkerContext —
// so this file takes only the one thing it actually needs, `ai`, typed as
// the narrow structural EstimatorAi port below (job-search AiPort pattern,
// external-modules/job-search/src/worker/stages/score.ts). Everything
// deadline- or db-related is the caller's concern (worker.ts), not this
// file's — `run.ts` stays pure: no ctx, no clock, no store.

import { validateNutrients, type EstimatorOutcome } from "../domain/estimate.js";
import { buildEstimatePrompt, ESTIMATE_SCHEMA, parseEstimateResult } from "./schema.js";

export interface EstimatorAi {
  generateStructured(input: {
    schema: Record<string, unknown>;
    prompt: string;
    maxOutputTokens?: number;
    tierHint?: "reasoning" | "interactive" | "economy";
  }): Promise<
    | { readonly ok: true; readonly object: unknown }
    | {
        readonly ok: false;
        readonly error:
          | "needs_config"
          | "validation_failed"
          | "provider_error"
          | "usage_limited"
          | "aborted";
      }
  >;
}

const FAILED_OUTCOME: EstimatorOutcome = {
  kind: "failed",
  nutrients: null,
  missingDetails: null,
  clarificationQuestion: null
};

/**
 * Converts a bounded meal description (+ optional serving note) into an
 * EstimatorOutcome. Never throws — every failure mode (a typed ai error, a
 * malformed response) degrades to `{kind: "failed"}` so a caller can
 * persist "failed" and let the retry queue try again, per the determinism
 * boundary (plan §3): the model gets exactly one job here (produce a
 * structured estimate, or say it needs details), and every other decision —
 * what state to persist, whether to retry, whether there is time left to
 * call at all — is the caller's job, not this function's and not the
 * model's. Deadline checking is deliberately NOT here: this file has no
 * clock and no ctx, only `ai` — see the file header.
 *
 * `model` on the returned outcome is always null: the real `ai` port's
 * success branch is `{ok: true, object: unknown}` — the host returns no
 * model or provider identifier at all (checked against
 * packages/module-sdk/src/worker.ts's ModuleWorkerContext["ai"] type), so
 * there is nothing here to name without hardcoding a guess. This also keeps
 * the provider-agnostic rule trivially satisfied: nothing in this module
 * ever names a provider or model.
 */
export async function estimateFromDescription(
  ai: EstimatorAi,
  description: string,
  servingNote: string | null
): Promise<EstimatorOutcome> {
  const result = await ai.generateStructured({
    schema: ESTIMATE_SCHEMA,
    prompt: buildEstimatePrompt(description, servingNote),
    // "interactive": Fork A (plan §2) runs this inline on the create-tool's
    // request path, so its latency IS the user's wait. The queue retry path
    // (worker.ts) reuses the same tier rather than branching on caller —
    // a slow retry is still better served fast than cheap.
    tierHint: "interactive"
  });

  if (!result.ok) {
    // Every documented ai error (needs_config, validation_failed,
    // provider_error, usage_limited, aborted) collapses to "failed" here:
    // EstimatorOutcome has no slot for WHY, by design (plan §3 — nothing
    // downstream renders provider-shaped detail). The retry queue treats
    // "failed" uniformly regardless of cause.
    return FAILED_OUTCOME;
  }

  let parsed;
  try {
    parsed = parseEstimateResult(result.object);
  } catch {
    // Schema-shape validation happens host-side before ok:true is ever
    // returned, so this should be unreachable in practice — kept as a
    // defensive boundary (never trust upstream shape absolutely) rather
    // than an assumed-safe cast.
    return FAILED_OUTCOME;
  }

  if (parsed.outcome === "needs_details") {
    return {
      kind: "needs_details",
      nutrients: null,
      missingDetails: parsed.missingDetails,
      clarificationQuestion: parsed.clarificationQuestion
    };
  }

  return {
    kind: "estimated",
    // Guard 3: the boundary validator, applied here regardless of what the
    // schema already constrained — a single bad field degrades to null
    // rather than discarding an otherwise-good estimate.
    nutrients: validateNutrients(parsed.nutrientFields),
    missingDetails: null,
    clarificationQuestion: null
  };
}
