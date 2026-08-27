# Build plan — News Settings publisher connection flow (#2008)

Part of #950. Child 3. Spec: the `SPEC` comment dated 2026-08-27T10:55 on issue #2008, plus
`docs/superpowers/specs/2026-08-26-950-news-credentialed-publisher-sources.md`.

Risk tier: security. Adversarial QA and Ben's merge sign-off apply.

---

## 1. Seams check — what the spec assumed, and what is actually on this branch

Every capability this plan leans on, cited from the current tree.

| Assumed                                                               | Actual                                                        | Citation                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Credential contracts exist                                            | Yes                                                           | `packages/shared/src/news-credentials-api.ts:33-64`                                                        |
| The five outcome sentences exist as constants                         | Yes — reuse, do not re-declare                                | `packages/shared/src/news-credentials-api.ts:20-26`                                                        |
| Four credential routes exist                                          | Yes                                                           | `packages/news/src/manifest.ts:262-288`; handlers `packages/news/src/credential-routes.ts:155,198,236,257` |
| A publisher connection port exists                                    | Yes, with `describe` + `validateKey`                          | `packages/news/src/publisher-connection-port.ts:23-30`                                                     |
| The port has `matchUrl`                                               | **No.** This plan adds it                                     | `packages/news/src/publisher-connection-port.ts:23-30`                                                     |
| The connection descriptor carries an access sentence and a terms link | **No.** It carries `host` only                                | `packages/news/src/publisher-connection-port.ts:8-17`                                                      |
| The reviewed connection registry exists (#2007)                       | Yes                                                           | `packages/news/src/source/newsapi-connection.ts:106-153`                                                   |
| The registry is wired into the running server                         | **No.** The composition root still passes the do-nothing port | `packages/module-registry/src/index.ts:1945`                                                               |
| Preview response type and its Fastify schema                          | Yes, and the schema is `additionalProperties: false`          | `packages/shared/src/news-api.ts:186-195` and `:621-676`                                                   |
| Preview handler builds the candidate list in one place                | Yes                                                           | `packages/news/src/personalization-routes.ts:391-402`                                                      |
| React Query keys are module-owned                                     | Yes                                                           | `packages/news/src/web/query-keys.ts:5-10`                                                                 |
| A house pattern for a write-only secret box                           | Yes                                                           | `apps/web/src/settings/module-credentials-section.tsx`                                                     |
| No jsdom / Testing Library — unit tests render to a string            | Yes                                                           | `tests/unit/news-settings-pane.test.tsx`                                                                   |

### Three corrections to the spec, and the decision taken on each

**(a) The offer's fields do not exist on the descriptor.** The spec wants to show the user a
sentence describing what the key grants and a link to the publisher's terms. The connection
declaration has neither. Decision: add `accessSummary: string` and `termsUrl: string | null` to
`PublisherConnection` and to `NewsConnectionDescriptor`, validated at import time alongside the
existing rules. One source of truth beats a second lookup table keyed by connection id.

**(b) The registry is built but never reaches the server.** #2007 merged the reviewed connection
and its validator, but `packages/module-registry/src/index.ts:1945` still passes the do-nothing
port, so `describe` returns nothing and no connection is reachable in the running product. Left
alone, everything this slice builds is unreachable code. Decision: add a registry-backed port in
the News package that answers `describe` and the new `matchUrl` from the reviewed connection list,
and wire the composition root to it. Its `validateKey` still answers "unsupported" — performing the
real outbound check is new runtime behaviour and belongs to #2006, which this issue's acceptance
criteria explicitly forbid changing here. Net effect: the key box becomes reachable for the one
reviewed publisher, and connecting answers "This publisher needs an access method News does not
support yet." That is exactly the state the spec says this screen must render correctly.

**Steelman of the option rejected:** leave the composition root alone, exactly as the spec's Task 2
says. It is a smaller diff on a security-tier PR, and it keeps every runtime change inside #2006.
Rejected because the spec's Task 2 was written expecting #2007 to do this wiring, #2007 did not,
and a screen no user can reach is the failure mode this repo keeps producing. The change is a pure
lookup over frozen constants with no network call, which is why it is safe to make here.

**(c) Two `SPEC` comments disagree on where the offer hangs.** The earlier one puts it on each
preview candidate; the later, more detailed one puts it on the preview response and requires
exactly one candidate. Decision: follow the later comment. Response-level plus a single-candidate
rule makes "never ask for a key on an ambiguous match" a property of the shape, not of the caller.

## 2. Determinism boundary

No model output appears anywhere in this flow. Every sentence the user reads is a constant selected
by branching on a typed outcome: the five in `NEWS_CREDENTIAL_MESSAGES`, the badge labels, and the
existing preview rejection copy. The publisher name, host, access sentence and terms link all come
from a frozen constant in our own source, never from a response body. No assistant or chat call
exists in any file this plan touches. No prompt, so no guidance budget applies.

## 3. Tasks

Each task commits green on its own.

### Task 1 — the connection offer, end to end in the contracts

Files: `packages/news/src/source/publisher-connection.ts`,
`packages/news/src/source/newsapi-connection.ts`, `packages/news/src/publisher-connection-port.ts`,
`packages/shared/src/news-credentials-api.ts`, `packages/shared/src/news-api.ts`.

Add to `PublisherConnection`:

```ts
readonly accessSummary: string;
readonly termsUrl: string | null;
```

`assertValidPublisherConnection` rejects an empty or whitespace-only `accessSummary`, and a
`termsUrl` that is neither `null` nor an `https:` URL.

Add the same two fields to `NewsConnectionDescriptor`.

Add to the port interface:

```ts
matchUrl(homepageUrl: string): NewsConnectionDescriptor | undefined;
```

`createEmptyNewsPublisherConnectionPort` returns `undefined` from it.

New in `packages/shared/src/news-credentials-api.ts`:

```ts
export interface NewsPublisherConnectionOfferDto {
  readonly connectionId: string;
  readonly publisherName: string;
  /** Exact HTTPS host the key will be sent to. Shown before the user types anything. */
  readonly requestHost: string;
  readonly accessSummary: string;
  readonly termsUrl: string | null;
}

export const newsPublisherConnectionOfferSchema: {
  /* additionalProperties: false, all five required, termsUrl nullable */
};
```

In `packages/shared/src/news-api.ts` add `readonly connection?: NewsPublisherConnectionOfferDto;`
to `NewsSourcePreviewResponse`, **and** the matching property to the 200 response block of
`previewNewsSourceSchema`. The schema is `additionalProperties: false`
(`packages/shared/src/news-api.ts:637`), so a type-only addition is silently dropped on the way out.

The offer carries no header name, no endpoint, no query table, no key.

Tests (`tests/unit/news-publisher-connections.test.ts`): a connection with a blank access sentence
is rejected; a connection with an `http:` terms link is rejected; a connection with a `null` terms
link is accepted. A broken build that skips this validation ships a key box with no explanation of
what the key grants.

### Task 2 — a registry-backed port, and the preview that uses it

Files: new `packages/news/src/source/publisher-connection-registry.ts`,
`packages/news/src/index.ts`, `packages/module-registry/src/index.ts`,
`packages/news/src/personalization-routes.ts`.

```ts
export function createRegistryNewsPublisherConnectionPort(): NewsPublisherConnectionPort;
```

`describe` and `matchUrl` read `PUBLISHER_CONNECTIONS`. `matchUrl` parses the URL, requires
`https:`, and matches on host equal to `canonicalDomain` or `www.` + `canonicalDomain` — nothing
else. A subdomain, a path-only string, an unparseable value or a near match returns `undefined`.
`validateKey` still answers `{ ok: false, reason: "unsupported" }`, with a comment naming #2006 as
the issue that replaces it.

`packages/module-registry/src/index.ts:1945` passes this instead of the do-nothing port.

`PersonalizationRouteDependencies` gains `readonly connections?: NewsPublisherConnectionPort;`, and
`packages/news/src/routes.ts` passes the same port instance it already passes to the credential
routes. In the preview handler's return
(`packages/news/src/personalization-routes.ts:391-402`), after the candidate list is built: when
there is **exactly one** candidate, call `matchUrl` on its `homepageUrl`; on a descriptor, add
`connection`. Absent dependency, more than one candidate, or no match: the response is byte for
byte what it is today.

Tests (`tests/unit/news-personalization-preview-connection.test.ts`, new): one candidate matching a
reviewed domain yields an offer carrying only the five display fields; two candidates with one
matching yields no offer; a subdomain yields no offer; no dependency yields no offer. A broken
build that offers on an ambiguous preview asks the user to send a key to a guessed publisher.

### Task 3 — client wrappers and a cache key

Files: `packages/news/src/web/news-client.ts`, `packages/news/src/web/query-keys.ts`.

```ts
export async function connectCredentialedNewsSource(
  input: ConnectNewsCredentialedSourceRequest & {
    readonly confirmationId: string;
    readonly candidateId?: string;
  }
): Promise<ConnectNewsCredentialedSourceResponse>;
export async function replaceNewsSourceCredential(
  sourceId: string,
  input: ReplaceNewsSourceCredentialRequest
): Promise<NewsSourceCredentialResponse>;
export async function revokeNewsSourceCredential(
  sourceId: string
): Promise<NewsSourceCredentialResponse>;
export async function listNewsSourceCredentials(): Promise<NewsSourceCredentialsResponse>;
```

Paths from `packages/news/src/manifest.ts:262-288`. The exact connect request body is whatever
`connectNewsCredentialedSourceSchema` accepts — read it at build time and match it; the schema is
`additionalProperties: false` so an extra field is a 400.

`newsQueryKeys.credentials = ["news", "credentials"] as const`. Only the list read is cached; the
three writes take the key as a plain argument and their results are never put in the cache.

### Task 4 — the connect form

New file `packages/news/src/settings/connect-publisher.tsx`. Its own file because
`packages/news/src/settings/index.tsx` is 526 lines against the 1000-line cap that
`pnpm check:file-size` enforces.

```ts
export type CredentialOutcome = keyof typeof NEWS_CREDENTIAL_MESSAGES;
export function credentialOutcomeMessage(outcome: string): string;
export function credentialStatusBadge(status: NewsSourceCredentialStatusDto["status"]): {
  readonly label: string;
  readonly tone: "pine" | "amber" | "neutral";
};
export function ConnectPublisherForm(props: {
  readonly offer: NewsPublisherConnectionOfferDto;
  readonly mode:
    | { readonly kind: "connect"; readonly confirmationId: string; readonly candidateId?: string }
    | { readonly kind: "replace"; readonly sourceId: string };
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): JSX.Element;
```

`credentialOutcomeMessage` reads `NEWS_CREDENTIAL_MESSAGES` — it does not restate the sentences, so
the screen cannot drift from what the route actually returned. An unrecognised key falls back to a
generic sentence and never shows the raw value, matching the rule `PREVIEW_REJECTION_COPY` already
follows at `packages/news/src/settings/add-source.tsx:23-28`.

Shows, in order: publisher name; one line naming the exact host the key goes to plus the access
sentence; the terms link when there is one; a key box; an authorisation checkbox; Connect and
Cancel; the outcome sentence once the request settles. Connect is disabled until the box has a
value and the checkbox is ticked.

The key box is `<input className="jds-input" type="password" autoComplete="off" />`, driven only by
local state that starts as an empty string.

Three rules the key must obey, each one a test:

- **The mutation must not keep the key.** `useMutation` holds `variables` after the request
  settles, so the key would stay readable in the query client. The mutation closes over a ref, the
  submitted argument carries no key, and `reset()` runs when it settles. A comment states which of
  the two approaches is used and why.
- **`value` is never sourced from server data.** There is no stored-key placeholder holding a real
  value. After a successful connection the box shows placeholder text only.
- **Nothing goes to browser storage.** No `localStorage`, `sessionStorage`, cookie, URL parameter
  or data attribute. Cleared on submit and again on unmount.

### Task 5 — wire the form into the two places it appears

Files: `packages/news/src/settings/add-source.tsx`, `packages/news/src/settings/index.tsx`.

**Adding.** When the preview came back with `connection`, render `ConnectPublisherForm` in place of
the "Add this source" button row. Everything else about the preview is unchanged. On success clear
the preview and invalidate `personalization`, `overview` and `credentials`.

**Managing.** In "Publications you add"
(`packages/news/src/settings/index.tsx:394-420`) read the credential list with a `useQuery` on the
new key. A source with a credential row gains its status badge, its last-checked time via the
timestamp helper already in that file, a "Replace key" control opening the same form in replace
mode, and a "Revoke access" control going through the existing confirm path. A source with no
credential row renders exactly as it does today.

### Task 6 — styles

`packages/news/src/settings/news-settings.css`, existing `nw-set__` naming, layout only. Every
colour, border, radius and type size from a token or a shared component, or
`pnpm check:design-tokens` fails. No new `jds-` name, or `pnpm check:ui-classes` fails.

### Task 7 — the browser test

Extend `tests/e2e/news-settings.spec.ts` with a local stateful mock in the style that file already
uses. Prove: an offer shows the publisher name and the exact host before the key box is usable;
submitting sends the key in the body of `POST /api/news/sources/credentialed` and nowhere else,
with no key in any request URL and the box empty afterwards; `localStorage` and `sessionStorage`
hold nothing resembling the key; a rejected replacement shows the "previous key is still active"
sentence and leaves the status unchanged; revoking shows the revoked sentence and changes the
badge; an ordinary public domain walks the existing path with no key box anywhere. The fake key is
obviously fake.

## 4. Unit tests

New `tests/unit/news-connect-publisher.test.tsx`, modelled on `tests/unit/news-settings-pane.test.tsx`.

| Case                                                                                                           | What a broken build does                                 |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Each of the five outcomes produces its exact sentence, and an unknown key the fallback                         | A reworded sentence drifts from what the route returned  |
| The key box renders `type="password"`, `autoComplete="off"`, and no `value` or `defaultValue` from server data | A "stored key" placeholder puts a secret back on screen  |
| A preview with no `connection` renders the ordinary Add row                                                    | Any URL gets asked for a secret                          |
| A preview with two candidates and a matching connection shows no key box                                       | A key is sent to a guessed publisher                     |
| A source with no credential row renders no Replace or Revoke control                                           | Credential controls appear on public sources             |
| Each credential status maps to its badge                                                                       | A revoked source reading "connected" hides a broken feed |

Extend `tests/unit/news-manifest.test.ts`: no assistant tool holds the `news.credentials`
permission. A key is only ever typed into this form.

## 5. Kill gate after Task 2

If wiring the registry-backed port turns out to change any existing behaviour beyond making
`describe` and `matchUrl` answer for the one reviewed publisher — any new outbound request, any
change to an existing test's expectations, anything touching the worker or feed compilation — stop,
revert the composition-root change, keep the do-nothing port, and record on the PR that the flow is
unreachable until #2006 wires it. Owner: this lane, recorded on the PR either way.

## 6. Verification — unpiped, exit code read directly

```
pnpm lint > /tmp/2008-lint.log 2>&1; echo "EXIT=$?"
pnpm format:check > /tmp/2008-fmt.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/2008-size.log 2>&1; echo "EXIT=$?"
pnpm check:ui-classes > /tmp/2008-ui.log 2>&1; echo "EXIT=$?"
pnpm check:design-tokens > /tmp/2008-tok.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/2008-tsc.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/unit/news-connect-publisher.test.tsx tests/unit/news-settings-pane.test.tsx tests/unit/news-manifest.test.ts tests/unit/news-publisher-connections.test.ts tests/unit/news-personalization-preview-connection.test.ts tests/unit/news-credential-routes.test.ts > /tmp/2008-unit.log 2>&1; echo "EXIT=$?"
pnpm exec playwright test tests/e2e/news-settings.spec.ts > /tmp/2008-e2e.log 2>&1; echo "EXIT=$?"
```

Every one expects `EXIT=0`. `pnpm verify:foundation` and anything else that touches the database is
run only through the `verify-gate` skill — an unscoped run points at the live development database.

## 7. Done means

- Any publisher address still goes through the existing check-and-add flow unchanged. A key box
  appears only when exactly one candidate matched a reviewed connection.
- The key box is a password field that starts empty, never fills from server data, clears on submit
  and on unmount, and leaves nothing in the query client or in browser storage.
- All five outcome sentences are reachable, worded exactly as the routes report them, and none of
  them shows a raw error, a provider response, a URL or the key.
- A connected source shows its status and offers Replace key and Revoke access. A public source
  shows neither.
- No change to encryption, to the worker, to how News refreshes, or to how a feed is compiled.
- The PR says plainly that connecting answers "not supported yet" until the live validation wiring
  lands with #2006, and that the live end-to-end proof for this feature belongs to #2006.
- The PR fills in the Release note section and commits the `docs/WHATS_NEW.md` change from
  `node scripts/append-release-note.mjs --pr <number>`.
