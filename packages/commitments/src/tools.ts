import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { assertDataContextDb } from "@moss/db";
import { CommitmentsRepository } from "./repository.js";

const repo = new CommitmentsRepository();

const LIST_STATUSES = [
  "pending_review",
  "accepted",
  "rejected",
  "snoozed",
  "expired",
  "explicit_non_action"
] as const;

function parseStatus(value: unknown): (typeof LIST_STATUSES)[number] {
  if (value === undefined || value === null) return "pending_review";
  if ((LIST_STATUSES as readonly unknown[]).includes(value)) {
    return value as (typeof LIST_STATUSES)[number];
  }
  throw new Error(`Invalid status: ${String(value)}`);
}

export const commitmentListExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const status = parseStatus((input as { status?: unknown } | null)?.status);
  const candidates = await repo.listCandidates(scopedDb, ctx.actorUserId, status);
  const items = candidates.map((c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    status: c.status,
    confidence: c.confidence,
    dueLocalDate: c.dueLocalDate,
    counterpartyLabel: c.counterpartyLabel,
    sourceCount: c.sourceCount,
    lastSeenAt: c.lastSeenAt.toISOString()
  }));
  return { data: { items } } satisfies ToolResult;
};

export const THREAD_JUDGEMENT_LOOKUP_CAP = 50;

/** Which email threads the closer look has already judged, and when. Ids and times only. */
export const commitmentThreadJudgementsExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const raw = (input as { threadRefs?: unknown }).threadRefs;
  const threadRefs = Array.isArray(raw)
    ? raw
        .filter((ref): ref is string => typeof ref === "string")
        .slice(0, THREAD_JUDGEMENT_LOOKUP_CAP)
    : [];
  const judged = await repo.listThreadJudgedAt(scopedDb, ctx.actorUserId, threadRefs);
  const threads = judged.map((j) => ({
    threadRef: j.threadRef,
    judgedAt: j.judgedAt.toISOString()
  }));
  return { data: { threads } } satisfies ToolResult;
};

export const commitmentGetExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { candidateId } = input as { candidateId: string };
  const candidate = await repo.getCandidate(scopedDb, ctx.actorUserId, candidateId);
  if (!candidate) return { data: { error: "Not found" } } satisfies ToolResult;
  const evidence = await repo.getEvidenceForCandidate(scopedDb, candidateId);
  return {
    data: {
      id: candidate.id,
      kind: candidate.kind,
      title: candidate.title,
      status: candidate.status,
      confidence: candidate.confidence,
      dueLocalDate: candidate.dueLocalDate,
      counterpartyLabel: candidate.counterpartyLabel,
      sourceCount: candidate.sourceCount,
      hasResolutionRef: candidate.resolutionRef !== null,
      evidence: evidence.map((e) => ({
        sourceKind: e.sourceKind,
        evidenceExcerpt: e.evidenceExcerpt,
        occurredAt: e.occurredAt?.toISOString() ?? null
      }))
    }
  } satisfies ToolResult;
};

export const commitmentAcceptExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { candidateId } = input as { candidateId: string };
  const candidate = await repo.updateStatus(scopedDb, ctx.actorUserId, candidateId, "accepted");
  return { data: { id: candidate.id, status: candidate.status } } satisfies ToolResult;
};

export const commitmentRejectExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { candidateId } = input as { candidateId: string };
  const candidate = await repo.updateStatus(scopedDb, ctx.actorUserId, candidateId, "rejected");
  return { data: { id: candidate.id, status: candidate.status } } satisfies ToolResult;
};

export const commitmentSnoozeExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { candidateId, snoozedUntil } = input as { candidateId: string; snoozedUntil: string };
  const candidate = await repo.updateStatus(
    scopedDb,
    ctx.actorUserId,
    candidateId,
    "snoozed",
    new Date(snoozedUntil)
  );
  return {
    data: { id: candidate.id, status: candidate.status, snoozedUntil }
  } satisfies ToolResult;
};
