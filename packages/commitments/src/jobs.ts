import type { PgBoss } from "pg-boss";
import { sendJob, assertMetadataOnlyPayload } from "@moss/jobs";
import { COMMITMENT_EMAIL_JUDGEMENT_QUEUE, COMMITMENT_EXTRACTION_QUEUE } from "./manifest.js";
import { sha8 } from "./signature.js";
import type { CommitmentSourceKind } from "./types.js";

export interface CommitmentExtractionJobPayload {
  readonly actorUserId: string;
  readonly sourceKind: CommitmentSourceKind;
  readonly idempotencyKey: string;
}

export async function enqueueCommitmentExtraction(
  boss: PgBoss,
  actorUserId: string,
  sourceKind: CommitmentSourceKind,
  idempotencyKey: string
): Promise<void> {
  const payload: CommitmentExtractionJobPayload = {
    actorUserId,
    sourceKind,
    idempotencyKey
  };
  assertMetadataOnlyPayload(payload);
  await sendJob(boss, COMMITMENT_EXTRACTION_QUEUE, payload, { singletonKey: idempotencyKey });
}

/**
 * A thread is judged once per burst of new mail, not once per message: the job waits this long
 * before it becomes visible, and pg-boss folds any further request for the same thread into it
 * through the singleton key.
 */
export const EMAIL_JUDGEMENT_DEBOUNCE_SECONDS = 180;

export interface EmailThreadJudgementJobPayload {
  readonly actorUserId: string;
  readonly threadRef: string;
  readonly idempotencyKey: string;
}

export function emailThreadJudgementKey(actorUserId: string, threadRef: string): string {
  return `email-thread:${actorUserId}:${sha8(threadRef)}`;
}

export async function enqueueEmailThreadJudgement(
  boss: PgBoss,
  actorUserId: string,
  threadRef: string
): Promise<void> {
  const payload: EmailThreadJudgementJobPayload = {
    actorUserId,
    threadRef,
    idempotencyKey: emailThreadJudgementKey(actorUserId, threadRef)
  };
  assertMetadataOnlyPayload(payload);
  await sendJob(boss, COMMITMENT_EMAIL_JUDGEMENT_QUEUE, payload, {
    singletonKey: payload.idempotencyKey,
    startAfter: EMAIL_JUDGEMENT_DEBOUNCE_SECONDS
  });
}
