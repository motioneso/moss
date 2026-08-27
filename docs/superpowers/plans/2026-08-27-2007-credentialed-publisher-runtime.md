# Build plan — #2007 reviewed API-key publisher connection runtime (News)

Part of #950. Spec: the `SPEC` comment on issue #2007
(https://github.com/motioneso/moss/issues/2007#issuecomment-5432...), scope-locked to NewsAPI.
Risk tier: security. Branch `fleet/lane-2007`.

This slice adds code and unit tests only. No routes, no migration, no UI, no manifest entry, no
composition-root wiring. #2006 (refresh) and #2008 (settings) consume what it exports.

## Seams check — every assumed capability, cited on this branch

| Assumed capability | Citation | State |
|---|---|---|
| Host-pinned outbound fetch with timeout + response cap + redirect re-check | `packages/host-fetch/src/index.ts:156` (`createHostPinnedFetch`, options `timeoutMs`/`maxResponseBytes`/`maxRedirects`) | exists |
| Host allowlist validation (no IP, no port, no uppercase, non-empty) | `packages/host-fetch/src/policy.ts:6` (`assertValidFetchHosts`) | exists |
| Re-export of both into `@moss/datasets` | `packages/datasets/src/host-pinning.ts:1` | exists |
| TTL + stale cache primitive | `packages/datasets/src/cache.ts` (`DatasetCache`) | exists |
| Sanitized-logging convention (source id, dataset key, outcome, error class only) | `packages/datasets/src/client.ts:158` | exists |
| `credential: "api-key"` refusal that must stay | `packages/datasets/src/client.ts:83`; `packages/module-registry/src/index.ts` registration guard | exists |
| Adapter contract + per-call `apiKey` slot | `packages/module-sdk/src/external-module.ts:404` and `:414` | exists, comment stale |
| Text/link/date/image sanitizers | `packages/news/src/source/sanitize.ts` | exists |
| Stable headline id from a URL | `packages/news/src/source/rss-source.ts:38` (`stableIdForUrl`) | exists |
| Headline shape delivered to the page | `packages/shared/src/news-api.ts:48` (`NewsHeadline`) | exists |
| Topic vocabulary | `packages/shared/src/news-api.ts:7` (`NewsTopicKey`, 8 keys) | exists |
| Encryption seam for stored keys | `packages/news/src/credential-cipher-port.ts` (`NewsCredentialCipherPort`) | exists (#2005) |
| Stored credential table with a generation counter | `packages/news/sql/0200_news_source_credentials.sql:26` | exists (#2005) |
| Repository read of the stored envelope | `packages/news/src/credential-repository.ts` (`readEnvelope`) | exists but returns no generation |
| `@moss/news` already depends on `@moss/datasets` | `packages/news/package.json` dependencies | exists |

### Drift found against the spec, and how this plan answers it

The spec was written before #2005 merged. #2005 is now on `main` (commit `3a24b3d3e`). Three
consequences:

1. **The key-lookup port must be wired, not left as a stand-in.** The spec's closing note says so
   explicitly. `readEnvelope` returns only the envelope, so it cannot answer "which generation".
   Task 6 adds a second read method that returns envelope, status and generation. It is added to
   the `NewsCredentialRepository` class only and **not** to the `NewsCredentialStore` interface,
   so the route fakes written by #2005 keep compiling.

2. **`packages/datasets` must not import `packages/news`.** The spec puts the connection type in
   News and the keyed runtime in Datasets. Datasets therefore declares a minimal structural
   interface (`KeyedSourceDeclaration`) that the News connection satisfies. No new package
   dependency in either direction.

3. **Open question, not built here: #2005's `NewsPublisherConnectionPort` cannot describe an API
   connection.** Its `NewsConnectionDescriptor` requires `retrievalMethod: "feed" | "scrape"`
   (`packages/news/src/publisher-connection-port.ts`). A NewsAPI connection is neither. #2005's
   comment says #2007 replaces the do-nothing implementation, but doing that would mean either
   lying about the retrieval method or widening #2005's type, which changes the behaviour of
   #2005's already-merged routes. **Decision: leave the do-nothing port in place, change nothing
   in that file, and raise the mismatch on the PR for #2008 to settle.** Steelman for building it
   anyway: the connect route stays dead until someone does. Rejected because a wrong value in a
   security-facing descriptor is worse than an obviously unfinished seam, and #2008 owns the
   settings surface that reads it.

## Determinism boundary

No user-facing surface, no model in the path. Every value that leaves this slice is either a
constant written into our own source or a sanitized field parsed from the upstream response. No
model output, no user-supplied string, and no configuration value can reach the outgoing host,
path, header name or query string.

## Tasks

Each task commits green. Test-first throughout.

### Task 1 — connection declaration type and its validation

New `packages/news/src/source/publisher-connection.ts`.

Contracts:

```ts
export const PUBLISHER_MAX_TIMEOUT_MS = 15_000;
export const PUBLISHER_MAX_RESPONSE_BYTES = 1_048_576;
export const PUBLISHER_MAX_ITEMS = 50;
export const PUBLISHER_MIN_INTERVAL_FLOOR_MS = 250;

/** Header names a reviewed connection is permitted to send the key in. */
export const ALLOWED_API_KEY_HEADERS: readonly string[];

export interface SanitizedPublisherItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly imageUrl: string | null;
  readonly summary: string;
  readonly providerName: string;
}

export interface PublisherConnection {
  readonly id: string;
  readonly publisherName: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly fetchHosts: readonly string[];
  readonly endpoint: string;
  readonly method: "GET";
  readonly apiKeyHeader: string;
  readonly fixedQuery: Readonly<Record<string, string>>;
  /** Topic key -> query values. "default" is the fallback for an unmapped topic. */
  readonly topicQuery: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxItems: number;
  readonly minIntervalMs: number;
  readonly parse: (body: unknown, connection: PublisherConnection) => SanitizedPublisherItem[];
}

export function assertValidPublisherConnection(connection: PublisherConnection): void;
export function assertValidPublisherConnectionRegistry(
  connections: readonly PublisherConnection[]
): void;
```

`assertValidPublisherConnection` rejects, each with a distinct message:
non-HTTPS endpoint; endpoint host absent from `fetchHosts`; an invalid host list (delegated to
`assertValidFetchHosts`); a method other than `GET`; an `apiKeyHeader` that is empty, contains
whitespace or a line break, or is not in `ALLOWED_API_KEY_HEADERS`; any fixed or topic query name
that is a known secret name (`key`, `apikey`, `api_key`, `api-key`, `apiKey`, `access_key`,
`token`, `auth`, `authorization`, case-insensitive, punctuation-insensitive); any fixed or topic
query value that looks like a secret placeholder (contains `{`, `}`, `$`, or matches
`key|token|secret` case-insensitively); a missing or non-positive timeout / response cap / item
cap, or any of them above its ceiling; a `minIntervalMs` below the floor.
`assertValidPublisherConnectionRegistry` additionally rejects a duplicate id.

**Why an allowlist of header names rather than "not computed":** a string cannot be asked at
runtime whether it was written down or built. A frozen list of reviewed header names is the
checkable form of the same rule.

Tests (`tests/unit/news-publisher-connections.test.ts`): one purpose-built bad declaration per
rejection above, each asserted to throw. A broken implementation that skipped any single check
would let its bad declaration through and fail that case.

### Task 2 — the one approved connection

New `packages/news/src/source/newsapi-connection.ts`.

```ts
export const NEWSAPI_CONNECTION_ID = "newsapi-top-headlines";
export const NEWSAPI_DATASET_KEY = "headlines";
export const newsApiConnection: PublisherConnection;
export const PUBLISHER_CONNECTIONS: readonly PublisherConnection[];   // Object.freeze'd
export function publisherConnection(id: string): PublisherConnection | undefined;
```

Values: host `newsapi.org`; endpoint `https://newsapi.org/v2/top-headlines`; method `GET`; header
`X-Api-Key`; fixed query `{ language: "en", pageSize: "20" }`; topic map
world/politics -> `{ category: "general" }`, us -> `{ country: "us" }`,
business -> `{ category: "business" }`, technology -> `{ category: "technology" }`,
science -> `{ category: "science" }`, health -> `{ category: "health" }`,
culture -> `{ category: "entertainment" }`, default -> `{ category: "general" }`;
timeout 10000 ms; response cap 524288 bytes; 20 items; minimum gap 1000 ms.

The parser accepts only `{ status: "ok", articles: [...] }`; anything else throws. Per item it
keeps title, url, publishedAt, description and `source.name`, runs each text field through the
existing sanitizers, drops an item with no usable HTTPS link or no title, always sets `imageUrl`
to `null` (no image host is declared for this connection — a known gap recorded for #2006), and
stops at `maxItems`.

Tests: added to `tests/unit/news-publisher-connections.test.ts` — the real connection passes
validation, and the registry is frozen (a runtime `push` throws in strict mode).

### Task 3 — the keyed dataset runtime

New `packages/datasets/src/keyed-client.ts`, re-exported from `packages/datasets/src/index.ts`.

```ts
export interface KeyedSourceDeclaration {
  readonly id: string;
  readonly fetchHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly minIntervalMs: number;
  readonly datasets: readonly { readonly key: string; readonly ttlMs: number }[];
}

export type KeyedCredentialFailureReason = "missing" | "revoked" | "unreadable";

export type KeyedCredentialLookupResult =
  | { readonly ok: true; readonly apiKey: string; readonly generation: string }
  | { readonly ok: false; readonly reason: KeyedCredentialFailureReason };

export type KeyedCredentialLookup<C> = (input: {
  readonly actorUserId: string;
  readonly sourceId: string;
  readonly credentialContext: C;
}) => Promise<KeyedCredentialLookupResult>;

export class KeyedCredentialUnavailableError extends Error {
  readonly name: "KeyedCredentialUnavailableError";
  constructor(reason: KeyedCredentialFailureReason);
  readonly reason: KeyedCredentialFailureReason;
}

export interface KeyedDatasetRequest<C> {
  readonly actorUserId: string;
  readonly sourceId: string;
  readonly datasetKey: string;
  readonly params: Record<string, unknown>;
  readonly credentialContext: C;
}

export interface KeyedDatasetEnvelope<T> {
  readonly data: T;
  readonly fetchedAt: string;
  readonly cached: boolean;
}

export interface KeyedDatasetClientDeps {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly maxEntriesPerSource?: number;
  readonly logger?: DatasetLogger;
}

export interface KeyedDatasetClient<C> {
  getDataset<T>(request: KeyedDatasetRequest<C>): Promise<KeyedDatasetEnvelope<T>>;
}

export function createKeyedDatasetClient<C>(
  declaration: KeyedSourceDeclaration,
  adapter: ExternalSourceAdapter,
  lookupCredential: KeyedCredentialLookup<C>,
  deps?: KeyedDatasetClientDeps
): KeyedDatasetClient<C>;
```

Decisions this encodes:

- **Cache key** `id:actorUserId:sourceId:generation:datasetKey:params`, params serialized the same
  way `buildCacheKey` does it today. Two users can never collide; a rotation bumps the generation
  and makes every earlier entry unreachable.
- **Lookup runs first, every call, including a cache hit** — otherwise a revoked key would keep
  being served from cache for the life of the entry. On `ok: false` the client throws
  `KeyedCredentialUnavailableError` and never calls the fetch function.
- **No fallback value and no serve-stale.** A keyed source that fails throws; the caller decides
  how to degrade. Silently returning an empty list would make a revoked key look like a quiet day.
- **The plaintext key is passed to the adapter only through the per-call context**, is never
  stored on the client, never written to the cache, and never appears in a log field.
- **The declaration's timeout and response cap are handed to `createHostPinnedFetch`**, and
  `minIntervalMs` gates the call rate exactly as the existing client does.
- **Failure logging** carries `sourceId`, `datasetKey`, `outcome` and `errorName` only.

Tests (`tests/unit/news-keyed-dataset-client.test.ts`): two users, same source and params, each
get their own fetch and neither sees the other's cached answer; a bumped generation makes the
earlier answer unreachable; a revoked key throws and the fetch stand-in is never called; a revoked
key after a successful cached call still throws and serves nothing; the declaration's timeout,
response cap and minimum gap reach the pinned fetch; the failure log record contains only those
four fields. A broken implementation that keyed the cache without the user or the generation fails
the first two.

### Task 4 — the credentialed adapter and the headline mapping

New `packages/news/src/source/credentialed-source.ts`.

```ts
export type CredentialedPublisherFailure = "authentication_failed" | "temporarily_unavailable";

export class CredentialedPublisherError extends Error {
  readonly name: "CredentialedPublisherError";
  constructor(failure: CredentialedPublisherFailure);
  readonly failure: CredentialedPublisherFailure;
}

export interface CredentialedPublisherParams {
  readonly topicKey: string | null;
}

export function createCredentialedPublisherAdapter(
  connection: PublisherConnection
): ExternalSourceAdapter;

export function toCredentialedHeadline(
  item: SanitizedPublisherItem,
  context: {
    readonly sourceKey: string;
    readonly topicKey: string | null;
    readonly topicLabel: string | null;
  }
): NewsHeadline;
```

The adapter builds the URL from the connection's endpoint plus its fixed query plus the topic
lookup only, sends the key in the declared header, and uses only `ctx.fetchFn`. Missing
`ctx.apiKey` is `temporarily_unavailable` and no request is made. 401/403 map to
`authentication_failed`; 429, any 5xx, a timeout, a connection error, and a response that is not
the documented shape all map to `temporarily_unavailable`. No provider body, header, URL or error
text is carried on the thrown error.

`toCredentialedHeadline` reuses `stableIdForUrl` for the id and carries `item.providerName`
through as `sourceLabel`.

Tests (`tests/unit/news-credentialed-source.test.ts`): the key is in the declared header and
appears nowhere in the URL or query string; the request goes to the declared endpoint with only
the declared query values, asserted for every topic in the lookup table plus an unmapped topic and
`null`; a good response parses into sanitized items, caps the count, drops items with no link or
no title, and always sets `imageUrl` to `null`; markup, over-long text and a garbled published
time all come out clean; a truncated or unexpected response throws rather than returning zero
items; each status maps to the documented failure and the thrown error's `message` and `stack`
contain no provider text, header value or URL; the mapped headline preserves the provider name.

### Task 5 — the key-lookup port for News

New `packages/news/src/source/credential-lookup-port.ts`.

```ts
export type NewsCredentialLookupResult = KeyedCredentialLookupResult;
export type NewsCredentialLookupPort = KeyedCredentialLookup<DataContextDb>;
```

Aliased rather than redeclared so the two sides cannot drift apart.

### Task 6 — wire the port to #2005's repository

Edit `packages/news/src/credential-repository.ts`: add one method to the
`NewsCredentialRepository` class (not to the `NewsCredentialStore` interface, so #2005's route
fakes keep compiling).

```ts
readCredentialForUse(
  scopedDb: DataContextDb,
  sourceId: string
): Promise<
  | { readonly status: "configured"; readonly envelope: EncryptedSecret; readonly generation: string }
  | { readonly status: "revoked" }
  | null
>;
```

New `packages/news/src/source/credential-lookup.ts`:

```ts
export interface NewsCredentialEnvelopeReader {
  readCredentialForUse(
    scopedDb: DataContextDb,
    sourceId: string
  ): Promise<
    | { readonly status: "configured"; readonly envelope: EncryptedSecret; readonly generation: string }
    | { readonly status: "revoked" }
    | null
  >;
}

export function createNewsCredentialLookup(deps: {
  readonly reader: NewsCredentialEnvelopeReader;
  readonly cipher: NewsCredentialCipherPort;
}): NewsCredentialLookupPort;
```

No row -> `missing`. A revoked row -> `revoked`. A decrypt that throws, or one that returns an
empty key -> `unreadable`, and the underlying error is swallowed so no cipher detail escapes.

Tests (`tests/unit/news-credential-lookup.test.ts`, a fourth file beyond the spec's three because
this task exists only to answer the #2005 drift): each of the four outcomes; the decrypted key is
returned only in the success value; a thrown cipher error becomes `unreadable` and its message
does not appear in the returned value; the generation is carried through as a string.

The repository method itself has no unit test — it is SQL under row security, and this lane may
not run a database test. Recorded as an integration gap for #2006 in the PR.

### Task 7 — exports and the stale comment

- `packages/news/src/index.ts` exports `PublisherConnection`, `SanitizedPublisherItem`,
  `PUBLISHER_CONNECTIONS`, `publisherConnection`, `newsApiConnection`, `NEWSAPI_CONNECTION_ID`,
  `NEWSAPI_DATASET_KEY`, `createCredentialedPublisherAdapter`, `toCredentialedHeadline`,
  `CredentialedPublisherError`, `createNewsCredentialLookup`, and the two lookup port types.
- `packages/datasets/src/index.ts` exports the Task 3 surface.
- `packages/module-sdk/src/external-module.ts`: update only the comment above
  `ExternalSourceAdapterContext` so it names the keyed runtime as the caller that sets `apiKey`.
  No behaviour change in that file.

## Kill gate after Task 1 — owner: this lane, escalating to the fleet record

If the validation rules cannot be expressed as checks that actually run against a declaration —
specifically if "the key can never reach the query string" ends up depending on reviewer
discipline rather than a check that throws — stop and record a blocker instead of continuing.
A validation function that only documents the rule is worse than none, because it reads as a
guarantee.

## Verification

Every command unpiped, exit code preserved. Expected `EXIT=0` for all.

```
pnpm exec eslint packages/datasets packages/news packages/module-sdk tests/unit/news-publisher-connections.test.ts tests/unit/news-credentialed-source.test.ts tests/unit/news-keyed-dataset-client.test.ts tests/unit/news-credential-lookup.test.ts --max-warnings=0 > /tmp/2007-eslint.log 2>&1; echo "EXIT=$?"
pnpm exec prettier --check "packages/datasets/**" "packages/news/**" "tests/unit/news-*.test.ts" > /tmp/2007-prettier.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/2007-typecheck.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/2007-filesize.log 2>&1; echo "EXIT=$?"
pnpm check:package-deps > /tmp/2007-deps.log 2>&1; echo "EXIT=$?"
pnpm test:unit tests/unit/news-publisher-connections.test.ts tests/unit/news-credentialed-source.test.ts tests/unit/news-keyed-dataset-client.test.ts tests/unit/news-credential-lookup.test.ts > /tmp/2007-new-tests.log 2>&1; echo "EXIT=$?"
pnpm test:unit tests/unit/dataset-client.test.ts tests/unit/dataset-cache.test.ts tests/unit/news-rss-source.test.ts tests/unit/news-manifest.test.ts tests/unit/news-service.test.ts > /tmp/2007-regression.log 2>&1; echo "EXIT=$?"
```

The last command proves the existing feed path and the module manifest still behave the same.

## No live path exists for this slice

Nothing here is reachable from the user interface: no route, no manifest entry, no composition-root
wiring. There is no live end-to-end run to record, and saying otherwise would be false. The PR says
so plainly. #2006 and #2008 own the first live proof.

## Exit criteria

- Only a connection in the frozen list can send an authenticated request; no path exists from user
  input to a new host, header or query value.
- Every unsafe declaration in Task 1 is rejected by a check, each proven by a test.
- A plaintext key exists only inside one bounded call; missing, revoked or unreadable stops the
  call before any request, with no unauthenticated fallback.
- A cached answer is tied to one user, one source row and one key generation.
- Failures report only "authentication failed" or "temporarily unavailable".
- Sanitized items map onto `NewsHeadline` with provider attribution intact.
- No route, migration, user interface, manifest entry or compilation change in the diff.
- All verification commands green and pasted into the PR; release note section filled in with
  `Category: N/A` (nothing here is user-visible on its own).
