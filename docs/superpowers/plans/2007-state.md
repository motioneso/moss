# Lane 2007 live state

Task: build the reviewed API-key publisher connection runtime for News (issue 2007).
Branch fleet/lane-2007. Spec = the SPEC comment on issue 2007 (saved at /tmp/spec-2007.md).

## Verified facts about the branch (checked 2026-08-27)

- createDatasetClient throws for credential "api-key" (packages/datasets/src/client.ts:83). Leave it.
- buildCacheKey has no user dimension (packages/datasets/src/client.ts:62). Leave it.
- createHostPinnedFetch lives in packages/host-fetch/src/index.ts:156, re-exported through
  packages/datasets/src/host-pinning.ts. Options: timeoutMs, maxResponseBytes, maxRedirects,
  resolve, request. assertValidFetchHosts in packages/host-fetch/src/policy.ts:6.
- ExternalSourceAdapterContext has optional apiKey (packages/module-sdk/src/external-module.ts:404),
  comment says "always absent today" - must be updated.
- Sanitizers: packages/news/src/source/sanitize.ts (sanitizeFeedText, sanitizeItemUrl,
  sanitizeImageUrl, sanitizePublishedAt, TITLE_CHAR_CAP 300, SUMMARY_CHAR_CAP 500).
- stableIdForUrl at packages/news/src/source/rss-source.ts:38.
- NewsHeadline at packages/shared/src/news-api.ts:48.
- Topic keys: world, us, politics, business, technology, science, health, culture
  (packages/shared/src/news-api.ts:7).
- news already depends on @moss/datasets.

## DRIFT: issue 2005 has already merged (commit 3a24b3d3e)

The spec was written assuming 2005 had not landed. It has. What 2005 shipped:

- packages/news/src/publisher-connection-port.ts - NewsPublisherConnectionPort,
  NewsConnectionDescriptor, NewsCredentialValidationOutcome, createEmptyNewsPublisherConnectionPort.
  Its comment says 2007 replaces the empty implementation with the real NewsAPI one.
- packages/news/src/credential-repository.ts - NewsCredentialRepository with readEnvelope()
  (returns envelope only, NOT the generation number) and NewsCredentialStore interface.
- packages/news/src/credential-cipher-port.ts - NewsCredentialCipherPort (encrypt/decrypt).
- packages/news/sql/0200_news_source_credentials.sql - table with a generation column.

Consequence: the spec's closing note says to wire the key-lookup port to the repository if 2005
landed. readEnvelope does not return generation, so a read that returns envelope + generation is
needed. Add it as a new method on the class only, NOT on the NewsCredentialStore interface, so
existing route fakes keep compiling.

## Next step

Write the plan with plan-build, then build test-first.
