# Build plan — #2005 Store News publisher credentials with owner-scoped lifecycle

Part of #950. Spec: the `SPEC` comment on issue #2005, itself derived from
`docs/superpowers/specs/2026-08-26-950-news-credentialed-publisher-sources.md`.
Risk tier: security.

Scope: storage, the encryption boundary, and the create/replace/revoke/status routes for a
user's own publisher API key. Explicitly NOT in scope: fetching from a publisher (#2007), the
Settings screen (#2008), wiring into the news refresh and the live proof (#2006).

## Spec drift found against this branch (verified 2026-08-27)

1. **Migration number.** The spec names `0192`. `0192` is taken
   (`packages/sports/sql/0192_sports_legacy_feed_assignments_verified.sql`); the highest number in
   use across `packages/*/sql` and `infra/postgres/migrations` is `0199`. **This plan uses `0200`.**
2. **A fifth place the new secret key must be listed.** The spec names four. There is a fifth:
   `scripts/smoke-compose.ts:230`. Missing it would crash-loop the compose smoke run the same way
   the module-credential key crash-looped the app container in #918. This plan adds all five.

Everything else in the spec was checked file-by-file and still holds.

## Seams check — every assumed capability, cited

| Assumption | Evidence |
| --- | --- |
| `withDataContext` opens one real transaction, so a source row and a credential row commit or roll back together | `packages/db/src/data-context.ts:63` |
| Repositories can reject an unscoped handle | `assertDataContextDb`, `packages/db/src/data-context.ts:74` |
| An AES-256-GCM JSON envelope type and cipher already exist | `EncryptedSecret` `packages/db/src/secret-cipher.ts:10`; `JsonSecretCipher` `:63`; `encryptJson` `:72`; `decryptJson` `:136` |
| A rotating keyring resolver already exists | `resolveKeyring`, `packages/db/src/keyring.ts:22` |
| A per-domain cipher subclass is an established pattern | `packages/settings/src/module-credential-crypto.ts:12` |
| Soft-revoke RLS (no DELETE grant) is an established table posture | `packages/settings/sql/0153_module_credentials.sql` |
| Metadata can be listed without selecting the ciphertext column | `packages/settings/src/repository-module-credentials.ts:69` |
| The per-user source cap and duplicate-publisher rule live in one method we can reuse | `createCustomSource`, `packages/news/src/personalization-repository.ts:157` |
| News routes have a sub-registration seam | `registerNewsPersonalizationRoutes` called at `packages/news/src/routes.ts:222` |
| The manifest declares migrations, owned tables, routes, permissions and deletion tables | `packages/news/src/manifest.ts:75`, `:83`, `:117`, `:135`, `:437` |
| The composition root wires News dependencies | `packages/module-registry/src/index.ts:1923` |
| Route errors have a shared shape | `HttpError` / `handleRouteError` from `@moss/module-sdk`, used at `packages/news/src/personalization-routes.ts:5` |
| A shared error response schema fragment exists | `errorResponseSchema`, `packages/shared/src/schema-fragments.ts:8` |
| Two existing tests pin lists that a new table/migration must join | `tests/integration/module-data-lifecycle-cascade.test.ts:136`, `tests/integration/foundation-schema-catalog.test.ts:278` |

No open questions. Nothing in this slice needs a capability that does not exist today.

## Determinism boundary

This slice adds no UI and no assistant tool, so there is no model in any path here. Stated for the
record because the risk tier demands it:

- Every message a user could ever see from these routes is one of five fixed strings chosen by a
  branch on a typed outcome, never generated.
- No assistant tool is registered for credentials, and the routes sit behind a new permission that
  no assistant tool holds. That is structural, not a convention.
- No model prompt, log line, job payload, export, or error message can contain the submitted key.

## Trust boundaries (security tier)

1. **Browser to route.** Request bodies are validated by Fastify schemas with
   `additionalProperties: false`. No response schema anywhere declares an `apiKey` property, so the
   serializer strips one even if a future bug tried to return it. Pinned by a test.
2. **Route to database.** Only the composition root can resolve key material. News holds an
   interface it cannot satisfy by itself, so News can never reach the keyring.
3. **Database row to actor.** Row security is enabled *and* forced, policies name
   `jarvis_app_runtime` only, and every policy is `owner_user_id = app.current_actor_user_id()`.
   No admin branch: admin power over News credentials is nil, not read-only.
4. **Worker.** No worker grant at all in this slice. #2007 adds the narrowest one it needs.

## Tasks

Each task commits green on its own.

### Task 1 — the table

New `packages/news/sql/0200_news_source_credentials.sql`.

```sql
CREATE TABLE IF NOT EXISTS app.news_source_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES app.news_custom_sources (id) ON DELETE CASCADE,
  connection_id text NOT NULL CONSTRAINT news_source_credentials_connection_id_ck
    CHECK (char_length(connection_id) BETWEEN 1 AND 64),
  encrypted_secret jsonb CONSTRAINT news_source_credentials_envelope_ck
    CHECK (encrypted_secret IS NULL OR jsonb_typeof(encrypted_secret) = 'object'),
  status text NOT NULL CONSTRAINT news_source_credentials_status_ck
    CHECK (status IN ('configured', 'revoked')),
  generation bigint NOT NULL DEFAULT 1,
  last_validated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_source_credentials_owner_source_uq UNIQUE (owner_user_id, source_id),
  CONSTRAINT news_source_credentials_state_ck CHECK (
    (status = 'configured' AND encrypted_secret IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND encrypted_secret IS NULL AND revoked_at IS NOT NULL)
  )
);
```

Then: enable and force row level security; four policies
(`news_source_credentials_{select,insert,update}`) `TO jarvis_app_runtime` with
`owner_user_id = app.current_actor_user_id()` in `USING` and `WITH CHECK` as applicable; no DELETE
policy; `GRANT SELECT, INSERT, UPDATE` to `jarvis_app_runtime` only. A trailing comment records
why there is no worker grant (#2007 owns the worker read path) and why there is no DELETE grant
(revoke is an update that scrubs the envelope).

There is no `not_configured` row state — a source with no credential simply has no row.

### Task 2 — type registration and manifest

`packages/db/src/types.ts`: add `NewsSourceCredentialsTable` next to `NewsCustomSourcesTable`
(around 1064), register `"app.news_source_credentials"` in the table map (around 1289), and export
`NewsSourceCredential = Selectable<NewsSourceCredentialsTable>` (around 1348).

```ts
export interface NewsSourceCredentialsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  source_id: string;
  connection_id: string;
  encrypted_secret: JsonColumn | null;
  status: "configured" | "revoked";
  generation: ColumnType<string, string | undefined, string>;
  last_validated_at: NullableTimestampColumn;
  revoked_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}
```

`generation` is `bigint`, which the driver returns as a string; the type says so rather than
pretending it is a number.

`packages/news/src/manifest.ts`: add the migration to `database.migrations`, the table to
`database.ownedTables`, and `{ table: "app.news_source_credentials" }` to
`dataLifecycle.deletion.tables`.

### Task 3 — the encryption boundary

New `packages/news/src/credential-cipher-port.ts`:

```ts
export interface NewsCredentialCipherPort {
  encrypt(secret: { readonly apiKey: string }): EncryptedSecret;
  decrypt(envelope: EncryptedSecret): { readonly apiKey: string };
}
```

News imports `EncryptedSecret` from `@moss/db` only. News must not import from `@moss/settings`
and must not call `resolveKeyring`.

New `packages/module-registry/src/news-credential-cipher.ts`, modelled on
`packages/settings/src/module-credential-crypto.ts`: a `NewsCredentialCipher extends
JsonSecretCipher` bound to the label `"news credential secret"`, plus
`createNewsCredentialSecretCipher(env)` resolving its own key family
`JARVIS_NEWS_CREDENTIAL_SECRET_KEY` / `..._KEY_ID` / `..._KEYS` with development default
`jarv1s-development-news-credential-secret`, and a small adapter satisfying
`NewsCredentialCipherPort`.

**This is the part that can break production.** `resolveKeyring` throws at boot when the key is
missing outside development and test. The same pull request adds the variable to all five places:

- `infra/env.production.example:40` (next to the module-credential key)
- `.github/workflows/ci.yml:255`
- `tests/uat/provisioner.ts:232`
- `tests/unit/uat-provisioner.test.ts:225` (the assertion)
- `scripts/smoke-compose.ts:230` — **not in the spec; found on the branch**

### Task 4 — shared contracts

New `packages/shared/src/news-credentials-api.ts`, re-exported from
`packages/shared/src/index.ts:38`. Not added to `news-api.ts`, which is 806 lines against a
1000-line cap.

```ts
export interface NewsSourceCredentialStatusDto {
  readonly sourceId: string;
  readonly connectionId: string;
  readonly publisherName: string;
  readonly status: "not_configured" | "configured" | "revoked";
  readonly lastValidatedAt: string | null;
  readonly revokedAt: string | null;
}
export interface ConnectNewsCredentialedSourceRequest {
  readonly connectionId: string;
  readonly apiKey: string;
}
export interface ReplaceNewsSourceCredentialRequest { readonly apiKey: string; }
export interface ConnectNewsCredentialedSourceResponse {
  readonly source: NewsCustomSourceDto;
  readonly credential: NewsSourceCredentialStatusDto;
  readonly message: string;
}
export interface NewsSourceCredentialResponse {
  readonly credential: NewsSourceCredentialStatusDto;
  readonly message: string;
}
export interface NewsSourceCredentialsResponse {
  readonly credentials: readonly NewsSourceCredentialStatusDto[];
}
```

Plus four Fastify schemas — `connectNewsCredentialedSourceSchema`,
`replaceNewsSourceCredentialSchema`, `revokeNewsSourceCredentialSchema`,
`listNewsSourceCredentialsSchema` — every object `additionalProperties: false`, request bodies
bounding `apiKey` length (1..512) and `connectionId` length (1..64), and error responses reusing
`errorResponseSchema`. No response schema declares an `apiKey`, an envelope, a header name, or a
generation.

### Task 5 — the repository

New `packages/news/src/credential-repository.ts` (not an extension of
`personalization-repository.ts`, which is 739 lines against the cap). Every method takes a
`DataContextDb`, calls `assertDataContextDb`, and relies on row security rather than a `WHERE` on
the owner column.

```ts
export interface NewsCredentialStatusRow {
  readonly sourceId: string;
  readonly connectionId: string;
  readonly status: "configured" | "revoked";
  readonly lastValidatedAt: Date | null;
  readonly revokedAt: Date | null;
}
export class NewsCredentialRepository {
  readStatuses(scopedDb: DataContextDb): Promise<NewsCredentialStatusRow[]>;
  readEnvelope(scopedDb: DataContextDb, sourceId: string): Promise<EncryptedSecret | null>;
  insertCredential(scopedDb: DataContextDb, input: {
    sourceId: string; connectionId: string; envelope: EncryptedSecret;
  }): Promise<NewsCredentialStatusRow>;
  rotateCredential(scopedDb: DataContextDb, sourceId: string, envelope: EncryptedSecret):
    Promise<{ generation: string } | null>;
  revokeCredential(scopedDb: DataContextDb, sourceId: string):
    Promise<NewsCredentialStatusRow | null>;
}
```

- `readStatuses` never selects `encrypted_secret`; it derives the boolean the way
  `listModuleCredentialMetadata` does.
- `readEnvelope` is the single method that reads the ciphertext column. It has no production
  caller in this slice; a comment says #2007 is the consumer.
- `rotateCredential` is one `UPDATE` setting the new envelope, `generation = generation + 1`,
  `last_validated_at = now()`, `status = 'configured'`, `revoked_at = NULL`.
- `revokeCredential` is one `UPDATE` setting `encrypted_secret = NULL`, `status = 'revoked'`,
  `revoked_at = now()`, and is written so a second call returns the same state rather than raising.

### Task 6 — the seam to #2007

New `packages/news/src/publisher-connection-port.ts` declaring `NewsConnectionDescriptor`,
`NewsCredentialValidationOutcome` (`{ok: true}` or `{ok: false, reason: "unsupported" |
"rejected" | "unavailable"}`) and `NewsPublisherConnectionPort` with `describe(connectionId)` and
`validateKey(connectionId, apiKey)`, exactly as the spec states them.

`packages/module-registry/src/index.ts:1923` injects an implementation that knows no connections:
`describe` returns undefined, `validateKey` returns `unsupported` for every id.

**Intended consequence, not a bug:** until #2007 merges, the connect route answers "This publisher
needs an access method News does not support yet" for every input. This sentence goes in the pull
request description.

### Task 7 — the routes

New `packages/news/src/credential-routes.ts`, called from `registerNewsRoutes` in
`packages/news/src/routes.ts` beside `registerNewsPersonalizationRoutes`.

```ts
export interface NewsCredentialRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly cipher: NewsCredentialCipherPort;
  readonly connections: NewsPublisherConnectionPort;
  readonly sources: Pick<NewsPersonalizationStore, "createCustomSource" | "listCustomSources">;
  readonly credentials?: NewsCredentialStore;
}
export function registerNewsCredentialRoutes(
  server: FastifyInstance, dependencies: NewsCredentialRouteDependencies
): void;
```

| Route | Behaviour |
| --- | --- |
| `POST /api/news/sources/credentialed` | Describe the connection; unknown id gives the unsupported answer. Validate the key. Only on success, inside ONE `withDataContext` call, create the source row through `createCustomSource` (so the per-user cap and duplicate rule keep working) with fingerprint `connection:<connectionId>:v1`, then insert the credential. On any failure nothing is written. |
| `POST /api/news/sources/:id/credential` | Validate the candidate first. On failure return the "previous key is still active" outcome with the stored row untouched. On success rotate and bump the generation. |
| `DELETE /api/news/sources/:id/credential` | Revoke. Idempotent. Returns status only. |
| `GET /api/news/credentials` | The actor's credential statuses. |

Fixed user-facing wording, chosen by branching on the typed outcome:

- unsupported: "This publisher needs an access method News does not support yet."
- rejected: "The publisher rejected this key. Your previous key is still active."
- unreachable: "The publisher could not be reached. Try again later."
- revoked: "Access revoked. Add a new key to reconnect this source."
- connected: "Connected. News will use this source on its next refresh."

Manifest changes in the same task, because an undeclared route stops the server from starting:
all four routes added to the `routes` array (`packages/news/src/manifest.ts:135`), and a new
permission

```ts
{
  id: "news.credentials",
  label: "Manage news publisher keys",
  description:
    "Add, replace, and revoke the active actor's own publisher access keys for news sources.",
  scope: "user",
  actions: ["create", "update", "delete"]
}
```

used by all four routes. Not `news.prefs`: the assistant tools are declared under `news.prefs`, and
these routes must sit behind something no assistant tool holds. No assistant tool is added.

Errors use `HttpError` plus `handleRouteError`. A validator that throws is caught and converted to
the "unreachable" outcome, so a provider error message can never carry the key upward.

### Task 8 — export, deletion, and the two pinned lists

`collectNewsExportSection` in `packages/news/src/data-lifecycle.ts` is not touched — credentials
are never exported — and a test pins that rather than leaving it to inspection.

- `tests/integration/module-data-lifecycle-cascade.test.ts:136` — add
  `"app.news_source_credentials"` to the pinned list.
- `tests/integration/foundation-schema-catalog.test.ts:278` — add
  `{ version: "0200", name: "0200_news_source_credentials.sql" }` to the ledger.

### Task 9 — tests

New `tests/unit/news-credential-routes.test.ts` and `tests/unit/news-credential-repository.test.ts`,
modelled on `tests/unit/news-routes.test.ts` with fake ports. Each case, and how it fails against a
broken implementation:

| Case | What a broken build does |
| --- | --- |
| A validator that rejects writes no source row and no credential row | A build that creates the source first, then validates, leaves an orphan source behind |
| A rejected replacement leaves envelope and generation exactly as they were | A build that rotates before validating destroys a working key on a typo |
| An accepted replacement increments the generation | A build that forgets the bump lets #2007 serve a cached response under a rotated-away key |
| Revoking twice succeeds both times with the same reported state | A build that reads-then-writes raises on the second call |
| The status object's exact key set contains no key, envelope, header name, or generation | A build that spreads the row into the response leaks the ciphertext |
| An error raised inside the validator does not carry the submitted key in its message | A build that interpolates the request body into an error writes the key into the logs |

New `tests/integration/news-credentials.test.ts`, modelled on
`tests/integration/news-personalization-repository.test.ts`:

| Case | What a broken build does |
| --- | --- |
| Row security is both enabled and forced; policies name `jarvis_app_runtime` only; `jarvis_worker_runtime` has no grant | Enabled-but-not-forced silently exempts the table owner |
| User B cannot read, rotate, or revoke user A's credential and gets no row back | A missing `WITH CHECK` lets B rotate A's key |
| An administrator actor gets no row either | An admin branch copied from `0153` would turn configuration power into data access |
| The stored envelope records aes-256-gcm and the plaintext key appears nowhere in the row | A build that stores the key in a stray column |
| Deleting the user removes the credential row; deleting the source removes it too | A missing cascade orphans ciphertext after account deletion |
| The News export for a user with a credential contains no credential fields | A future edit to the export collector leaks the envelope |

## Verification

Run under the `verify-gate` skill for anything touching the database. Never piped.

```bash
pnpm lint > /tmp/2005-lint.log 2>&1; echo "EXIT=$?"            # expect 0
pnpm format:check > /tmp/2005-fmt.log 2>&1; echo "EXIT=$?"     # expect 0
pnpm check:file-size > /tmp/2005-size.log 2>&1; echo "EXIT=$?" # expect 0
pnpm typecheck > /tmp/2005-tc.log 2>&1; echo "EXIT=$?"         # expect 0
pnpm test:unit > /tmp/2005-unit.log 2>&1; echo "EXIT=$?"       # expect 0
pnpm db:migrate > /tmp/2005-mig.log 2>&1; echo "EXIT=$?"       # expect 0
pnpm test:integration > /tmp/2005-int.log 2>&1; echo "EXIT=$?" # expect 0
```

Known local noise, not this branch: the module-sdk-worker unit tests fail locally and pass in CI.
Do not bisect over them.

## End-to-end proof for this slice

The spec assigns the live user-interface proof to #2006, which is the slice that puts a credential
on screen. This slice adds no screen, so there is nothing a person can click. What stands in its
place, and is an exit criterion here, is the integration test above run against a real database:
it exercises the migration, the row security posture, two separate users, an administrator actor,
the real cipher, and account and source deletion. Its observed output goes on the pull request.
The pull request says plainly that the live proof belongs to #2006, so a reviewer does not read
its absence as an oversight.

## Kill gate

**Observation that ends the line:** the integration test shows a second user, an administrator, or
the worker role able to read or change another user's credential row, and the fix is not a policy
change but a change to how the platform scopes actors. **Owner: Ben** — that would be a hard
invariant failing, not a bug in this slice.

## Rejected option, steelmanned

**Reuse the existing module-credential key family instead of adding a new one.** In its favour:
it adds no required environment variable, so it cannot crash-loop production, and it removes the
five-file edit that is the riskiest part of this change. The reason to reject it is rotation
coupling — rotating a News publisher key would force every module credential to rotate with it,
and vice versa, which is exactly the property the separate family in
`packages/settings/src/module-credential-crypto.ts:21` was created to get. A separate family with
all five deployment configs updated in the same pull request buys independent rotation at a cost
that is bounded and checkable. Taking the new family, per the spec.

## Release note

Nothing a user can see ships here. The pull request template gets `Category: N/A` and
`docs/WHATS_NEW.md` is not touched.
