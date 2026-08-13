export { embedChunks, EMBED_CONCURRENCY } from "./embed-chunks.js";
export {
  CpuIsolatedEmbeddingProvider,
  EMBED_MAX_TOKENS,
  LocalEmbeddingProvider,
  resetEmbeddingPipelineCacheForTests
} from "./local-embedding-provider.js";
export type { EmbeddingProvider } from "./embedding-provider.js";
export { StubEmbeddingProvider } from "./embedding-provider.js";
export { IngestionService } from "./ingestion-service.js";
export type { IngestOptions, IngestStats, IngestFailure } from "./ingestion-service.js";
export type {
  EmbeddingProviderConfig,
  EmbeddingRuntimeConfigResolver,
  EmbeddingProviderKind
} from "./embedding-provider-config.js";
export {
  createEmbeddingProvider,
  getEmbeddingProviderConfig
} from "./embedding-provider-config.js";
export { MemoryIngestPipeline } from "./ingest.js";
export type { IngestFileOptions, IngestFileResult, IngestStatus } from "./ingest.js";
export {
  HARD_EXCLUDED_PREFIXES,
  isPathIngestable,
  listVaultIngestRootProviders,
  registerVaultIngestRootProvider,
  resolveIngestRoots
} from "./vault-ingest-registry.js";
export type { VaultIngestRootProvider } from "./vault-ingest-registry.js";
export { memoryModuleManifest, memorySqlMigrationDirectory, MEMORY_MODULE_ID } from "./manifest.js";
export type {
  MemoryCandidateAction,
  MemoryCandidateKind,
  MemoryCandidateProvenance,
  MemoryCandidateRecord,
  MemoryCandidateSignatureInput,
  MemoryCandidateStatus,
  NewMemoryCandidate
} from "./candidates-repository.js";
export {
  createMemoryCandidateSignature,
  MemoryCandidatesRepository
} from "./candidates-repository.js";
export {
  ManualMemoryCandidateService,
  type ManualMemoryCandidateInput
} from "./manual-candidates.js";
export type { ParsedDocument, TextChunk } from "./parser.js";
export { parseDocument } from "./parser.js";
export type {
  NewChunkData,
  RetrievedChunk,
  VaultFileChunk,
  VaultFileWithChunks
} from "./repository.js";
export { MemoryRepository } from "./repository.js";
export { MemoryRetriever } from "./retrieval.js";
export type {
  MemoryFact,
  NewFactData,
  FactCategory,
  FactStatus,
  FactProvenance
} from "./facts-repository.js";
export { ChatMemoryFactsRepository } from "./facts-repository.js";
export * from "./graph-types.js";
export { MemoryGraphRepository } from "./graph-repository.js";
export { MemoryGraphDashboardRepository } from "./graph-dashboard-repository.js";
export { MemoryDashboardService } from "./dashboard-service.js";
export { GraphMemoryRecallService } from "./graph-recall-service.js";
export { registerMemoryGraphRoutes } from "./graph-routes.js";
export type { MemoryGraphRouteDependencies } from "./graph-routes.js";
export { registerMemoryDashboardRoutes } from "./dashboard-routes.js";
export type { MemoryDashboardRouteDependencies } from "./dashboard-routes.js";
export { memoryForgetExecute, memoryRecallExecute, memoryRememberExecute } from "./graph-tools.js";
export { createMemoryFactSignature, normalizeMemoryFactContent } from "./fact-signature.js";
export type {
  AcceptMemoryCandidateRequest,
  MemoryDashboardItem,
  MemoryDashboardItemKind,
  MemoryDashboardQuery,
  MemoryDashboardResponse,
  MemoryDashboardStatusFilter,
  MemoryEditableField,
  PatchMemoryEntityDashboardRequest,
  PatchMemoryFactDashboardRequest,
  RejectMemoryCandidateRequest,
  SuppressMemoryCandidateRequest
} from "./dashboard-types.js";
export type {
  MemoryCorrection,
  MemoryCorrectionSource,
  MemorySuppression,
  MemorySuppressionReason,
  NewMemorySuppression
} from "./suppressions-repository.js";
export { ChatMemorySuppressionsRepository } from "./suppressions-repository.js";
