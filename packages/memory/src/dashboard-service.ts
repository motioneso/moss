import { assertDataContextDb, type DataContextDb } from "@moss/db";

import { candidateSummary, candidateTitle } from "./candidate-labels.js";
import type { MemoryCandidateRecord } from "./candidates-repository.js";
import { MemoryCandidatesRepository } from "./candidates-repository.js";
import type {
  AcceptMemoryCandidateRequest,
  MemoryDashboardItem,
  MemoryDashboardQuery,
  MemoryDashboardResponse,
  PatchMemoryEntityDashboardRequest,
  PatchMemoryFactDashboardRequest
} from "./dashboard-types.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { MemoryGraphDashboardRepository } from "./graph-dashboard-repository.js";
import type { MemoryGraphRepository } from "./graph-repository.js";
import { GraphMemoryRecallService } from "./graph-recall-service.js";
import type {
  MemoryEpisodeKind,
  MemoryFactPredicate,
  MemoryFactRecord,
  MemoryRecordKind,
  MemorySourceInput,
  MemorySourceSummary
} from "./graph-types.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export class MemoryDashboardService {
  private readonly dashRepo: MemoryGraphDashboardRepository;
  private readonly candidatesRepo: MemoryCandidatesRepository;
  private readonly recallSvc: GraphMemoryRecallService;

  constructor(
    private readonly graphRepo: MemoryGraphRepository,
    embeddingProvider: EmbeddingProvider
  ) {
    this.dashRepo = new MemoryGraphDashboardRepository(graphRepo);
    this.candidatesRepo = new MemoryCandidatesRepository();
    this.recallSvc = new GraphMemoryRecallService(embeddingProvider, graphRepo);
  }

  async getDashboard(
    scopedDb: DataContextDb,
    ownerUserId: string,
    query: MemoryDashboardQuery
  ): Promise<MemoryDashboardResponse> {
    assertDataContextDb(scopedDb);
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));

    const [candidateCounts, factCounts] = await Promise.all([
      this.candidatesRepo.countByStatus(scopedDb, ownerUserId),
      this.dashRepo.countFactsByStatus(scopedDb, ownerUserId)
    ]);
    const counts = { ...candidateCounts, ...factCounts };

    const status = query.status ?? "pending";
    let items: MemoryDashboardItem[];
    let nextCursor: string | undefined;

    if (
      status === "pending" ||
      status === "rejected" ||
      status === "suppressed" ||
      status === "promoted"
    ) {
      const page = await this.candidatesRepo.listForDashboard(scopedDb, ownerUserId, {
        status: [status],
        limit,
        cursor: query.cursor
      });
      items = page.items.map(candidateToItem);
      nextCursor = page.nextCursor;
    } else if (status === "all") {
      const [pending, facts] = await Promise.all([
        this.candidatesRepo.listForDashboard(scopedDb, ownerUserId, {
          status: ["pending"],
          limit: Math.ceil(limit / 2)
        }),
        this.dashRepo.listFactsForDashboard(scopedDb, ownerUserId, {
          statuses: ["active", "stale", "conflicting"],
          limit: Math.floor(limit / 2),
          cursor: query.cursor
        })
      ]);
      items = [...pending.items.map(candidateToItem), ...facts.items.map(factToItem)].slice(
        0,
        limit
      );
      nextCursor = facts.nextCursor;
    } else {
      const factStatuses = statusFilterToFactStatuses(status);
      const page = await this.dashRepo.listFactsForDashboard(scopedDb, ownerUserId, {
        statuses: factStatuses,
        recordKind: query.recordKind,
        limit,
        cursor: query.cursor
      });
      items = page.items.map(factToItem);
      nextCursor = page.nextCursor;
    }

    return { counts, items, nextCursor };
  }

  async acceptCandidate(
    scopedDb: DataContextDb,
    ownerUserId: string,
    candidateId: string,
    req: AcceptMemoryCandidateRequest
  ): Promise<{ accepted: boolean }> {
    assertDataContextDb(scopedDb);
    const pending = await this.candidatesRepo.getById(scopedDb, ownerUserId, candidateId);
    if (!pending || pending.status !== "pending") return { accepted: false };
    // The earlier read is not a claim: another accept may have passed it too. Only
    // the transaction that updates the still-pending row may create its memory.
    const candidate = await this.candidatesRepo.claimPendingForPromotion(
      scopedDb,
      ownerUserId,
      candidateId,
      "accepted via dashboard"
    );
    if (!candidate) return { accepted: false };

    const payload = candidate.payloadJson as Record<string, unknown> | null;
    const kind = typeof payload?.kind === "string" ? payload.kind : null;
    const factPayload = (payload?.fact ?? null) as Record<string, unknown> | null;
    const edited = req.edited;

    const dashboardSource: MemorySourceInput = {
      sourceKind: "manual" as MemoryEpisodeKind,
      sourceRef: "dashboard-review",
      sourceLabel: "Memory dashboard",
      excerpt: ""
    };

    if (kind === "fact" && factPayload) {
      const predicate = String(factPayload.predicate ?? "related_to");
      const objectText = String(edited?.summary ?? factPayload.objectText ?? "");
      if (!objectText.trim()) {
        const err = new Error("Candidate objectText must not be empty") as NodeJS.ErrnoException;
        err.code = "EMPTY_OBJECT_TEXT";
        throw err;
      }
      const recordKind = (edited?.recordKind ??
        factPayload.recordKind ??
        "preference") as MemoryRecordKind;

      const subjectEntityId = await this.resolveCandidateSubject(
        scopedDb,
        ownerUserId,
        factPayload.subject
      );

      // #561: always create via remember(); multiple active facts with the same predicate
      // are valid in the memory model (e.g. "prefers dark mode" and "prefers early mornings"
      // are independent). Predicate-only conflict detection would silently supersede unrelated
      // memories. Conflict routing is delegated to the recall layer's own deduplication.
      const result = await this.recallSvc.remember(scopedDb, ownerUserId, {
        subjectEntityId,
        predicate: predicate as MemoryFactPredicate,
        objectText,
        recordKind,
        confidence: 1.0,
        provenance: "confirmed",
        pinned: edited?.pinned,
        source: dashboardSource
      });
      const acceptedFact = result.fact;

      if (edited?.validFrom != null || edited?.validTo != null || edited?.staleAt != null) {
        await this.dashRepo.patchFactLifecycle(scopedDb, ownerUserId, acceptedFact.id, {
          validFrom: edited.validFrom ?? null,
          validTo: edited.validTo ?? null,
          staleAt: edited.staleAt ?? null
        });
      }
    } else {
      const summaryText = edited?.summary ?? candidateSummary(payload);
      const selfEntity = await this.graphRepo.ensureSelfEntity(scopedDb, ownerUserId);
      await this.recallSvc.remember(scopedDb, ownerUserId, {
        subjectEntityId: selfEntity.id,
        predicate: "related_to",
        objectText: summaryText,
        recordKind: "preference",
        confidence: 1.0,
        provenance: "confirmed",
        source: dashboardSource
      });
    }

    return { accepted: true };
  }

  private async resolveCandidateSubject(
    scopedDb: DataContextDb,
    ownerUserId: string,
    subject: unknown
  ): Promise<string> {
    const name = typeof subject === "string" ? subject.trim() : "";
    // Suggestions saved before subjects were tracked have none, and describe the owner.
    if (!name) return (await this.graphRepo.ensureSelfEntity(scopedDb, ownerUserId)).id;
    const resolved = await this.graphRepo.resolveSubjectEntityId(scopedDb, ownerUserId, name);
    if (resolved) return resolved;
    const err = new Error(
      `More than one memory entity is named "${name}". Merge or rename them, then approve again.`
    ) as NodeJS.ErrnoException;
    err.code = "AMBIGUOUS_SUBJECT";
    throw err;
  }

  async rejectCandidate(
    scopedDb: DataContextDb,
    ownerUserId: string,
    candidateId: string,
    reason: string
  ): Promise<{ rejected: boolean }> {
    assertDataContextDb(scopedDb);
    const rejected = await this.candidatesRepo.markRejected(
      scopedDb,
      ownerUserId,
      candidateId,
      reason || "rejected by user"
    );
    return { rejected };
  }

  async suppressCandidate(
    scopedDb: DataContextDb,
    ownerUserId: string,
    candidateId: string,
    reason: string
  ): Promise<{ suppressed: boolean }> {
    assertDataContextDb(scopedDb);
    const suppressed = await this.candidatesRepo.markSuppressed(
      scopedDb,
      ownerUserId,
      candidateId,
      reason || "suppressed by user"
    );
    return { suppressed };
  }

  async patchFact(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string,
    patch: PatchMemoryFactDashboardRequest
  ): Promise<{ patched: boolean }> {
    assertDataContextDb(scopedDb);
    const updated = await this.dashRepo.patchFactLifecycle(scopedDb, ownerUserId, factId, patch);
    return { patched: updated != null };
  }

  async patchEntity(
    scopedDb: DataContextDb,
    ownerUserId: string,
    entityId: string,
    patch: PatchMemoryEntityDashboardRequest
  ): Promise<{ patched: boolean }> {
    assertDataContextDb(scopedDb);
    const updated = await this.dashRepo.updateEntity(scopedDb, ownerUserId, entityId, patch);
    return { patched: updated != null };
  }

  async deleteEntity(
    scopedDb: DataContextDb,
    ownerUserId: string,
    entityId: string
  ): Promise<{ deleted: boolean; blockedByFacts: boolean }> {
    assertDataContextDb(scopedDb);
    return this.dashRepo.forgetEntity(scopedDb, ownerUserId, entityId);
  }
}

function statusFilterToFactStatuses(filter: string): string[] {
  switch (filter) {
    case "active":
      return ["active"];
    case "stale":
      return ["stale"];
    case "conflicting":
      return ["conflicting"];
    case "history":
      return ["superseded", "expired"];
    case "inactive":
      return ["archived", "superseded", "expired"];
    default:
      return ["active", "stale", "conflicting"];
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_REF_PREFIX_RE = /^(?:memory|internal|ref|id):/i;

function isRawInternalRef(ref: string): boolean {
  return UUID_RE.test(ref) || INTERNAL_REF_PREFIX_RE.test(ref);
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  chat: "Chat",
  note: "Note",
  task: "Task",
  email: "Email",
  calendar: "Calendar",
  manual: "Manual"
};

function safeSourceSummary(source: MemorySourceSummary | undefined): string {
  if (!source) return "";
  if (source.sourceLabel) return source.sourceLabel;
  if (isRawInternalRef(source.sourceRef)) {
    return SOURCE_KIND_LABELS[source.sourceKind] ?? "Memory";
  }
  return source.sourceRef;
}

function candidateToItem(c: MemoryCandidateRecord): MemoryDashboardItem {
  const payload = c.payloadJson as Record<string, unknown> | null;
  const title = candidateTitle(payload);
  const recordKind =
    typeof payload?.recordKind === "string" ? (payload.recordKind as MemoryRecordKind) : undefined;
  return {
    itemKind: "candidate",
    id: c.id,
    title,
    summary: candidateSummary(payload),
    recordKind,
    status: c.status,
    confidence: c.confidence,
    provenance: c.provenance,
    sourceSummary: "",
    sourceKind: "chat",
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    editableFields:
      c.status === "pending" ? ["summary", "recordKind", "validFrom", "validTo", "staleAt"] : []
  };
}

function factToItem(f: MemoryFactRecord): MemoryDashboardItem {
  const source = f.sources[0];
  return {
    itemKind: "fact",
    id: f.id,
    title: factTitle(f),
    summary: f.objectText ?? "",
    recordKind: f.recordKind,
    status: f.status,
    confidence: f.confidence,
    confidenceTier: f.confidenceTier,
    provenance: f.provenance,
    sourceSummary: safeSourceSummary(source),
    sourceKind: source?.sourceKind ?? "chat",
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    staleAt: f.staleAt?.toISOString() ?? null,
    validFrom: f.validFrom?.toISOString() ?? null,
    validTo: f.validTo?.toISOString() ?? null,
    conflictGroupId: f.conflictGroupId ?? null,
    supersededByFactId: f.supersededByFactId ?? null,
    pinned: f.pinned,
    editableFields: ["validFrom", "validTo", "staleAt", "pinned"]
  };
}

function factTitle(f: MemoryFactRecord): string {
  const parts = [f.predicate, f.objectText].filter(Boolean);
  return parts.join(": ") || "Memory fact";
}
