import { assertDataContextDb, type DataContextDb } from "@moss/db";

import type { EmbeddingProvider } from "./embedding-provider.js";
import { MemoryGraphDashboardRepository } from "./graph-dashboard-repository.js";
import { MemoryGraphRepository } from "./graph-repository.js";
import type {
  MemoryFactProvenance,
  MemoryFactRecallCandidate,
  MemoryFactRecord,
  MemoryForgetResult,
  MemoryCorrectionInput,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryRecallResult,
  MemoryRememberInput,
  MemoryStatusPatchInput,
  MemorySupersedeInput,
  MemoryWriteResult,
  NewMemoryFact
} from "./graph-types.js";

const DEFAULT_RECALL_LIMIT = 10;
const CORE_LIMIT = 20;

export class GraphMemoryRecallService {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly repository = new MemoryGraphRepository()
  ) {}

  async remember(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: MemoryRememberInput
  ): Promise<MemoryWriteResult> {
    assertDataContextDb(scopedDb);
    const subjectEntityId =
      input.subjectEntityId ?? (await this.repository.ensureSelfEntity(scopedDb, ownerUserId)).id;
    const fact = await this.repository.createFact(scopedDb, ownerUserId, {
      ...input,
      subjectEntityId
    } satisfies NewMemoryFact);

    const names = await this.repository.getOtherSubjectNames(scopedDb, ownerUserId, [
      fact.subjectEntityId
    ]);
    const searchText = factSearchText(fact, names.get(fact.subjectEntityId));
    await this.repository.upsertSearchDocument(
      scopedDb,
      ownerUserId,
      "fact",
      fact.id,
      searchText,
      await this.embeddingProvider.embedDocument(searchText),
      this.embeddingProvider.modelName,
      this.embeddingProvider.modelVersion
    );

    return { fact };
  }

  async recall(
    scopedDb: DataContextDb,
    ownerUserId: string,
    query: string,
    options: MemoryRecallOptions = {}
  ): Promise<MemoryRecallResult> {
    assertDataContextDb(scopedDb);
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return { query: trimmedQuery, items: [] };

    const queryEmbedding = await this.embeddingProvider.embedQuery(trimmedQuery);
    const candidates = await this.repository.listFactRecallCandidates(
      scopedDb,
      ownerUserId,
      queryEmbedding,
      { includeInactive: options.includeInactive, includeStale: options.includeStale }
    );
    const names = await this.repository.getOtherSubjectNames(
      scopedDb,
      ownerUserId,
      candidates.map((candidate) => candidate.fact.subjectEntityId)
    );
    const items = candidates
      .map((candidate) => toRecallItem(candidate, trimmedQuery, names))
      .filter((item) => options.includeInactive || item.score > 0)
      .filter(
        (item) =>
          options.includeLowConfidence ||
          item.confidence >= 0.6 ||
          directMatchScore(trimmedQuery, item.text) >= 0.85
      )
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
      .slice(0, options.limit ?? DEFAULT_RECALL_LIMIT);

    return { query: trimmedQuery, items };
  }

  async core(scopedDb: DataContextDb, ownerUserId: string): Promise<MemoryRecallResult> {
    assertDataContextDb(scopedDb);
    const facts = await this.repository.listCoreFacts(scopedDb, ownerUserId, CORE_LIMIT);
    const names = await this.repository.getOtherSubjectNames(
      scopedDb,
      ownerUserId,
      facts.map((fact) => fact.subjectEntityId)
    );
    return {
      query: "",
      items: facts.map((fact) => factToRecallItem(fact, 1, names))
    };
  }

  async forget(
    scopedDb: DataContextDb,
    ownerUserId: string,
    target: { readonly factId: string }
  ): Promise<MemoryForgetResult> {
    assertDataContextDb(scopedDb);
    return {
      deleted: (
        await new MemoryGraphDashboardRepository(this.repository).forgetFactWithConflictCleanup(
          scopedDb,
          ownerUserId,
          target.factId
        )
      ).deleted
    };
  }

  async supersede(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: MemorySupersedeInput
  ): Promise<{ readonly factId: string; readonly superseded: boolean }> {
    assertDataContextDb(scopedDb);
    return {
      factId: input.factId,
      superseded: await this.repository.supersedeFact(
        scopedDb,
        ownerUserId,
        input.factId,
        input.validTo ?? new Date()
      )
    };
  }

  async confirm(
    scopedDb: DataContextDb,
    ownerUserId: string,
    target: { readonly factId: string }
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    return this.repository.confirmFact(scopedDb, ownerUserId, target.factId);
  }

  async correct(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: MemoryCorrectionInput
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    return this.repository.correctFact(scopedDb, ownerUserId, input);
  }

  async patchStatus(
    scopedDb: DataContextDb,
    ownerUserId: string,
    factId: string,
    input: MemoryStatusPatchInput
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    return this.repository.patchFactStatus(scopedDb, ownerUserId, factId, input);
  }

  async markStale(
    scopedDb: DataContextDb,
    ownerUserId: string,
    target: { readonly factId: string }
  ): Promise<MemoryFactRecord | undefined> {
    assertDataContextDb(scopedDb);
    return this.repository.markFactStale(scopedDb, ownerUserId, target.factId);
  }

  async pin(
    scopedDb: DataContextDb,
    ownerUserId: string,
    target: { readonly factId: string },
    pinned: boolean
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    return this.repository.pinFact(scopedDb, ownerUserId, target.factId, pinned);
  }
}

function toRecallItem(
  candidate: MemoryFactRecallCandidate,
  query: string,
  names: ReadonlyMap<string, string>
): MemoryRecallItem {
  const fact = candidate.fact;
  const keywordMatch = keywordScore(query, candidate.searchText);
  const score =
    0.4 * candidate.vectorSimilarity +
    0.25 * keywordMatch +
    0.15 * fact.importance +
    0.1 * provenanceBoost(fact.provenance) +
    0.05 * (fact.pinned ? 1 : 0) +
    0.05 * freshnessBoost(fact.lastConfirmedAt ?? fact.updatedAt ?? fact.createdAt);

  return factToRecallItem(fact, roundScore(score), names);
}

function factToRecallItem(
  fact: MemoryFactRecord,
  score: number,
  names: ReadonlyMap<string, string>
): MemoryRecallItem {
  const subjectName = names.get(fact.subjectEntityId);
  return {
    ...(subjectName ? { subjectName } : {}),
    kind: "fact",
    id: fact.id,
    title: fact.predicate,
    text: fact.objectText ?? fact.objectEntityId ?? "",
    score,
    recordKind: fact.recordKind,
    status: fact.status,
    confidence: fact.confidence,
    confidenceTier: fact.confidenceTier,
    provenance: fact.provenance,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    staleAt: fact.staleAt,
    supersededByFactId: fact.supersededByFactId,
    conflictGroupId: fact.conflictGroupId,
    sources: fact.sources
  };
}

function directMatchScore(query: string, text: string): number {
  return keywordScore(query, text);
}

function factSearchText(fact: MemoryFactRecord, subjectName?: string): string {
  return [subjectName, fact.predicate, fact.objectText].filter(Boolean).join(" ");
}

function keywordScore(query: string, text: string): number {
  const terms = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return 0;

  const haystack = text.toLocaleLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return matches / terms.length;
}

function provenanceBoost(provenance: MemoryFactProvenance): number {
  switch (provenance) {
    case "confirmed":
      return 1;
    case "volunteered":
      return 0.8;
    case "imported":
      return 0.6;
    case "inferred":
      return 0.4;
  }
}

function freshnessBoost(date: Date | null): number {
  if (!date) return 0;
  const days = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
  return Math.max(0, 1 - days / 365);
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
