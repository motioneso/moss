// external-modules/meals/src/log/job.ts
//
// The log-estimate job. The entry is saved before this job is queued, so a failure here leaves a
// saved entry that is still pending or failed, never a lost one. Every ordinary non-event
// (entry gone, revision moved on) returns a status instead of throwing.
import { estimateFromDescription } from "../estimator/run.js";
import type { LogJobDeps } from "./deps.js";

export interface LogJobResult {
  readonly status: "no-op" | "recorded";
  readonly reason?: string;
}

function readParams(params: Record<string, unknown>): { entryId: string; revision: number } {
  const { entryId, revision } = params;
  if (typeof entryId !== "string" || entryId.length === 0) {
    throw new Error("log-estimate: entryId must be a non-empty string");
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new Error("log-estimate: revision must be a positive integer");
  }
  return { entryId, revision };
}

export async function runLogEstimate(
  deps: LogJobDeps,
  params: Record<string, unknown>
): Promise<LogJobResult> {
  const { entryId, revision } = readParams(params);

  const entry = await deps.store.getEntry(entryId);
  if (entry === null) return { status: "no-op", reason: "entry_not_found" };
  // A correction landed after this job was queued. Estimating the old text would overwrite it.
  if (entry.estimateRevision !== revision) return { status: "no-op", reason: "stale_revision" };
  // Only a waiting entry needs an estimate. An estimated one is the user's to correct.
  if (entry.estimateState !== "pending") return { status: "no-op", reason: "not_pending" };

  const outcome = await estimateFromDescription(deps.ai, entry.description, entry.servingNote);
  const recorded = await deps.store.recordEstimate(entryId, revision, {
    state: outcome.kind,
    items: outcome.items,
    nutrients: outcome.nutrients,
    missingDetails: outcome.missingDetails,
    clarificationQuestion: outcome.clarificationQuestion
  });
  if (recorded === null) return { status: "no-op", reason: "stale_revision" };
  return { status: "recorded" };
}
