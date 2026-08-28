export { registerNewsRoutes } from "./routes.js";
// #1025: re-exported so root-level tests/uat/seed/* can write prefs through the real
// repository (same precedent as @moss/auth's hashPassword re-export for admin.ts).
export { NewsPrefsRepository } from "./repository.js";
export type { NewsRoutesDependencies, NewsPrefsWriter } from "./routes.js";
// #2005: the two seams the composition root must satisfy, plus the repository so the
// integration tests can exercise the real read/write path.
export type { NewsCredentialCipherPort } from "./credential-cipher-port.js";
export type {
  NewsStoryFeedbackPort,
  NewsStorySurface,
  NewsStoryTargetRow
} from "./story-feedback-port.js";
export {
  NewsCredentialRepository,
  type NewsCredentialStatusRow,
  type NewsCredentialStore
} from "./credential-repository.js";
export {
  createEmptyNewsPublisherConnectionPort,
  type NewsConnectionDescriptor,
  type NewsCredentialValidationOutcome,
  type NewsPublisherConnectionPort
} from "./publisher-connection-port.js";
export {
  NEWS_QUEUE_DEFINITIONS,
  NEWS_REFRESH_QUEUE,
  NEWS_REVALIDATE_QUEUE,
  enqueueNewsRefresh,
  enqueueNewsRevalidation,
  registerNewsJobWorkers
} from "./jobs.js";
export type { NewsRefreshPayload, NewsRevalidatePayload } from "./jobs.js";
export type { NewsAiPort, NewsSafeFetchPort, NewsWebSearchPort } from "./discovery/ports.js";
export {
  NEWS_MODULE_ID,
  newsAddSourceRequirement,
  newsModuleManifest,
  newsModuleSqlMigrationDirectory
} from "./manifest.js";
export { configureNewsBriefingService, newsTopHeadlinesTodayExecute } from "./briefing-tool.js";
export { configureNewsChatTools } from "./chat-tools.js";
export type { NewsChatToolDependencies } from "./chat-tools.js";
export {
  createRssDatasetAdapter,
  isPublicFeedDocument,
  parsePublicFeedItems
} from "./source/rss-source.js";
// #1572: declared public seam so Sports' own (URL-only) source discovery can reuse News'
// reviewed feed-discovery, sanitize, domain-normalization and policy-check primitives instead
// of importing News internals or re-implementing them.
export {
  discoverFeedUrls,
  extractListingHeadlines,
  sampleFeedHeadlines
} from "./discovery/feed-discovery.js";
export {
  TITLE_CHAR_CAP,
  SUMMARY_CHAR_CAP,
  sanitizeFeedText,
  sanitizeItemUrl,
  sanitizeImageUrl,
  sanitizePublishedAt
} from "./source/sanitize.js";
export {
  NEWS_MAX_CUSTOM_SOURCES,
  normalizePublisherDomain,
  publisherDomainMatches
} from "./personalization-domain.js";
export { decideSourcePolicy, NEWS_POLICY_VERDICT_TTL_MS } from "./discovery/policy-validation.js";

// #2007 — the reviewed API-key publisher connection runtime. Nothing here is wired into a
// route or the module manifest yet; #2006 and #2008 own that.
export {
  ALLOWED_API_KEY_HEADERS,
  assertValidPublisherConnection,
  assertValidPublisherConnectionRegistry
} from "./source/publisher-connection.js";
export type { PublisherConnection, SanitizedPublisherItem } from "./source/publisher-connection.js";
export {
  NEWSAPI_CONNECTION_ID,
  NEWSAPI_DATASET_KEY,
  newsApiConnection,
  publisherConnection,
  PUBLISHER_CONNECTIONS
} from "./source/newsapi-connection.js";
export {
  createCredentialedPublisherAdapter,
  CredentialedPublisherError,
  toCredentialedHeadline
} from "./source/credentialed-source.js";
export type { CredentialedPublisherFailure } from "./source/credentialed-source.js";
export { createNewsCredentialLookup } from "./source/credential-lookup.js";
export type { NewsCredentialEnvelopeReader } from "./source/credential-lookup.js";
export type {
  NewsCredentialLookupPort,
  NewsCredentialLookupResult
} from "./source/credential-lookup-port.js";
