import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { assertDataContextDb } from "@moss/db";
import { CommitmentsRepository } from "./repository.js";

const repo = new CommitmentsRepository();

export const commitmentListExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const candidates = await repo.listCandidates(scopedDb, ctx.actorUserId, "pending_review");
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
