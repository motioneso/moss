# Build plan: classifier gate 2b.5 — candidate lists, runtime menus and replies

Task issue: #2905. Parent spec: `docs/superpowers/specs/2026-10-01-classifier-gate-for-chat.md`.
Parent plan section: `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md` → "2b.5 Candidate
preparation, runtime menus and replies" (+ "Contracts and invariants", "Rulings"). Ben's rulings 5,
6, 7 and 8.

Base branch: `cg-2b-5-candidates`, forked from `origin/main` at `52d5c85d6` (2b.4, PR 2902).
Builds on 2b.2 (PR 2888) storage, 2b.3 (PR 2895) preparation and 2b.4 (PR 2902) editor; the merged
SDK contract 2.1, classifier routing 3.1, gateway gate path 3.2, gate decision engine 3.3 and
shadow storage 3.4 are consumed, never reshaped. No migration. Tier: security.

## Goal and boundary

Turn the owner-reviewed connected-tool preparation into the classifier's actual runtime menu, and
provide the two code-authored pieces the gate needs for connected tools:

1. **Candidate lists.** Resolve an argument's `candidateSource` to a reviewed read-only listing tool
   on the same connection, call it once through the gateway (a user-requested setup read), extract a
   bounded `{id, label}` list with a code-authored mapping, and cache it owner-scoped with a
   fingerprint and expiry. The gate's candidate hook reads that cache; it never calls a tool.
2. **Reply contract.** One renderer that prefers the reviewed template, otherwise the envelope
   summary, with the section's exact strings, and never shows raw `detail`.

This slice is **integration runtime + contracts only**: no screen (2b.4), no candidate-editor UI, no
new endpoint, no migration, and no real-screen proof (2b.6). The synthetic tool manifest is the
production consumer of the menu declaration: `createIntegrationsActiveModulesResolver` feeds
`AssistantToolGateway.executableTools`, and the merged gate engine (3.3) reads a tool's
`classifier` metadata when it builds `GateTool[]`. The refresh trigger and the reply renderer are
exposed for the runtime gate wiring lane (3.5/4.x); their gateway port is injected so this slice
stays testable and module-independent.

Determinism boundary: every candidate label, menu description and reply string comes from a stored
reviewed record or a code-authored constant, never from model prose. The listing tool's result is
data, never instructions. Nothing here executes a chat action; the listing call is a setup read.

## Seams check (each cited from the current tree)

- Runtime menu source to extend: `packages/integrations/src/tool-manifests.ts:89-162`
  (`createIntegrationsActiveModulesResolver`), `:164-279` (`buildToolManifest`), `:281-296`
  (`buildSyntheticModule`). Synthetic tools are already `risk:"outbound"`, `executionPolicy:"auto"`,
  `isExternal:true`, `externalContent:true` (`:268-278`) — leave all of that unchanged (ruling 7).
- Eligibility to consume, not reshape: `packages/integrations/src/classifier-settings.ts:338-397`
  (`ClassifierConnectionState`, `EligibleClassifierTool`, `effectiveClassifierTools`), bounds at
  `:22-34`; fingerprint at `packages/integrations/src/classifier-fingerprint.ts:28-41`.
- SDK contract to build against (2.1, merged): `packages/module-sdk/src/classifier.ts:16-23`,
  `:32-72` (`ClassifierArgumentDecl`, `ClassifierCandidate`, `ClassifierCandidateProvider`,
  `ModuleAssistantToolClassifier`), `:196-209` (`checkClassifierEligibility`), `:219-241`
  (`normalizeClassifierCandidates`). Manifest field at `packages/module-sdk/src/index.ts:652-653`.
- Gateway gate path (3.2, merged): `packages/ai/src/gateway/gateway.ts:217-266`
  (`callToolForGate`, no-card), types `packages/ai/src/gateway/types.ts:70-90`. The listing call
  goes through this path, never through `mcp-client.ts`/`openapi-invoke.ts` directly.
- Result envelope and summaries: `packages/integrations/src/tool-manifests.ts:34-40`
  (`IntegrationOutcomeEnvelope`), `packages/integrations/src/summaries.ts:2-12`
  (`INTEGRATION_SUMMARY` already holds the success/truncation/suppression strings).
- Gate consumption of the declaration: `packages/chat/src/live/classifier-gate.ts:259-291`
  (menu + candidate load), `:461-484` (`optionsFor`), `:517-524` (reply render);
  `packages/chat/src/live/classifier-gate-arguments.ts:78-95` (`gateEligibilityProblem`),
  `:196-214` (risk bars), `:229-239` (`renderReplyTemplate`). Chat has no `@moss/integrations`
  dependency (`packages/chat/package.json`), so the integration reply helper is injected/wired by
  the composition lane, not imported by chat.
- Cache precedent: `packages/integrations/src/resolver-cache.ts:11-52` (owner-keyed, TTL,
  drop-on-edit singleton). Repository cache drop points already exist at
  `packages/integrations/src/routes.ts:312,334` and refresh/delete paths.
- Shared contracts to extend: `packages/shared/src/integrations-api.ts:40-88`
  (`IntegrationClassifierArgument` already carries `candidateSource`), `:90-107`
  (`IntegrationDetail`).
- Manifest + app map to update: `packages/integrations/src/manifest.ts:20-111`;
  `packages/shared/src/app-map-core.ts:170-190` (integrations declaration). Regenerate with
  `pnpm build:app-map`.
- Existing tests to mirror: `tests/unit/integrations-classifier-settings.test.ts` (pure-module
  style), `tests/unit/integrations-classifier-preparation.test.ts` (injected ports),
  `tests/unit/calendar-classifier-tool.test.ts:140-190` (reply-template/decline semantics).
- Plan privacy item to edit: parent plan "Additional seams requiring a ruling" →
  "Prepared text and candidate privacy" (parent plan lines 865-872).

No gate/DB command runs except through `scripts/run-gate.sh` (verify-gate skill). No migration.

## Decisions

### D1 — New `packages/integrations/src/classifier-candidates.ts`

Pure resolution + a small in-memory cache + an injected listing port. No route, no UI, no DB.

```ts
export const CANDIDATE_CACHE_TTL_MS = 300_000; // 5 minutes, an implementation bound
export const INTEGRATION_CANDIDATE_MAX = CLASSIFIER_LIMITS.candidates; // 50

export interface CandidateListingRequest {
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly toolName: string;       // the reviewed read-only listing tool
  readonly signal: AbortSignal;
}
export type CandidateListingOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reason: "declined" | "unavailable" | "failed" };
export interface CandidateListingPort {
  /** Wired by the composition lane to the gateway's no-card path. Never a direct MCP call. */
  callReadOnlyListingTool(request: CandidateListingRequest): Promise<CandidateListingOutcome>;
}

/** The reviewed read-only listing tool a candidateSource names, or null. */
export function resolveCandidateListingTool(
  state: ClassifierConnectionState,
  sourceName: string
): EligibleClassifierTool | null;

/** Code-authored extraction mapping. Projects only {id,label}; rejects the list whole on any
 *  violation. Never returns raw remote fields. */
export function extractCandidatesFromListing(
  result: unknown
): readonly ClassifierCandidate[] | null;

export interface CandidateCache { get/set/drop/dropConnection/clear }
export function createCandidateCache(deps?: { now?: () => number; ttlMs?: number }): CandidateCache;

/** One explicit user-requested refresh. Returns a fixed reason on any failure; never caches a
 *  partial or failed list. */
export async function refreshConnectionCandidates(input: {
  readonly state: ClassifierConnectionState;
  readonly connectionId: string;
  readonly actorUserId: string;
  readonly sourceName: string;
  readonly port: CandidateListingPort;
  readonly cache: CandidateCache;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly refreshed: boolean; readonly reason?: string }>;

/** The gate hook's read. Owner must match; expires and fingerprint mismatch return null. */
export function loadCachedCandidates(input: {
  readonly cache: CandidateCache;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly sourceName: string;
  readonly sourceFingerprint: string;
  readonly now: () => number;
}): readonly ClassifierCandidate[] | null;
```

- `resolveCandidateListingTool` requires: connection enabled, classifier switch on, no discovery
  error, the named tool still discovered and ordinary-chat enabled, a saved entry with
  `optIn === true`, `reviewedRisk === "read"`, and a current fingerprint. A server `readOnly` hint
  alone never qualifies (ruling 5).
- `extractCandidatesFromListing` accepts only an `ok` envelope (or a bare array) whose entries are a
  non-empty string, or an object with `id` plus one of `label`/`name`, or `entity_id` plus
  `friendly_name`. Everything else returns null. Cap 50, id/label non-empty and ≤ 80, unique ids and
  unique labels (a duplicate is ambiguous, so the whole list is rejected), no truncation.
- Cache key is `ownerUserId|connectionId|sourceName`; a stored value also carries the listing tool's
  `sourceFingerprint`. `loadCachedCandidates` returns null on owner mismatch, key miss, expiry, or
  fingerprint mismatch. `refreshConnectionCandidates` drops the key on any non-`ok` outcome so a
  failed refresh cannot preserve eligibility.
- `dropConnection(owner, connectionId)` is called from the existing invalidation points that already
  `cache.drop(actorUserId)` (route review save/remove, connection edit/refresh/delete), so a changed
  discovery or opt-out invalidates immediately.

### D2 — New `packages/integrations/src/classifier-reply.ts`

One pure renderer; the section's strings verbatim.

```ts
export const CLASSIFIER_REPLY = {
  performedOk: "Action performed successfully.",
  readOk: "Read succeeded.",
  unconfirmed: "The action could not be confirmed. Check the connected service before trying again."
} as const;

/** Renders the handled reply, or null when the result cannot support one.
 *  Precedence: (1) reviewed template over the validated/sanitized result; (2) a preserved
 *  INTEGRATION_SUMMARY meaning (already-done, refused, truncated); (3) error/unknown status ->
 *  CLASSIFIER_REPLY.unconfirmed; (4) success -> summary, else performedOk/readOk by action.
 *  Never emits `detail`. */
export function renderIntegrationClassifierReply(input: {
  readonly template: string;
  readonly result: unknown; // sanitized structured result
  readonly envelope: {
    readonly status: unknown;
    readonly action: unknown;
    readonly summary: unknown;
  };
}): string | null;
```

- A template that cannot resolve a placeholder falls through to the envelope summary; the
  renderer returns null only when no branch can produce a reply (an unknown action with an empty
  success summary). It never fills an error with success text.
- The preserved meanings reuse `INTEGRATION_SUMMARY.blockedRead`, `.blockedPerformed`,
  `.truncated`, `.requestRefused`; `callFailed` is **not** passed through (it points at `detail`),
  the unconfirmed string replaces it.

### D3 — Attach the declaration in `tool-manifests.ts`

Compute `effectiveClassifierTools(connState)` once per connection in the resolver loop
(`:109-135`) and pass a `Map<toolName, EligibleClassifierTool>` into `buildToolManifest`. For an
eligible tool:

- add `outputSchema: INTEGRATION_CLASSIFIER_OUTPUT_SCHEMA` =
  `{ type: "object", additionalProperties: false, properties: { status: {type:"string"},
action: {type:"string"}, summary: {type:"string"} } }` — so a reviewed template using
  `{status}/{action}/{summary}` passes `checkClassifierEligibility` and the gateway's
  `sanitizeAssistantToolResult` hands the gate exactly those fields (no `detail`);
- add `classifier: { description, arguments, replyTemplate }` from the eligible entry, mapping
  `IntegrationClassifierArgument` to the SDK's `{ kind }` declarations;
- when an argument is `candidates`, add `candidates: ClassifierCandidateProvider` that reads
  `loadCachedCandidates` with the listing tool's current fingerprint and throws on a miss (the gate
  turns a throw into `candidates_unavailable`). At most one `candidates` argument is allowed by the
  gate; the provider captures that argument's `candidateSource`.

Preserve the ordinary manifest fields and curation exactly; only add `classifier` and the
`outputSchema` needed by the declaration. A tool with no current reviewed entry is unchanged.

### D4 — Manifest, app map and the open privacy item

- `packages/integrations/src/manifest.ts`: add feature `integrations.connection_classifier_candidates`
  (≤ 240 chars) describing device-name candidate lists sent to the classifier, the owner-scoped
  cache/expiry, and that a missing/expired list keeps the tool out; add an
  `integrations.connection_classifier_candidates.unavailable` error with a remediation pointing at
  reviewing the connection's device-listing tool as "Only reads" and switching it on. Add the
  candidate route only if D1 grows one (it does not), so `routes[]` is unchanged.
- `packages/shared/src/app-map-core.ts` `integrations` declaration: one added sentence naming the
  device-name candidate list, the read-only reviewed listing tool behind it, and that names are
  cached briefly and refreshed by the owner. Run `pnpm build:app-map`.
- Parent plan: edit the "Prepared text and candidate privacy" open item to record that ruling 8
  resolved it (prepared descriptions and device-name candidate lists are allowed; credentials,
  secrets and example values are not), and mark spec 3.3/3.4 reconciled by the same ruling.

### D5 — Deferred wiring (named, not silently dropped)

The refresh trigger and the reply renderer reach a handled turn only through the runtime gate
composition (3.5/4.x), which owns the chat↔gateway wiring. This slice exposes the injected
`CandidateListingPort` and the pure renderer so that lane can wire them without reshaping 2b.5. No
UI, route or gateway construction is added here. This is recorded in the PR body, not implied.

## Tasks (each commits green; explicit `git add` paths)

1. **Candidates module** (D1) — `packages/integrations/src/classifier-candidates.ts`, exported from
   `packages/integrations/src/index.ts`. Unit tests.
2. **Reply module** (D2) — `packages/integrations/src/classifier-reply.ts`, exported. Unit tests.
3. **Runtime menu wiring** (D3) — `packages/integrations/src/tool-manifests.ts`; unit tests assert
   the built synthetic manifest carries the declaration and output schema.
4. **Manifest + app map + privacy item** (D4) — `packages/integrations/src/manifest.ts`,
   `packages/shared/src/app-map-core.ts`, the parent plan; `pnpm build:app-map`.
5. **Unit suite** — `tests/unit/integrations-classifier-runtime.test.ts` (below).

## Test cases (behaviour + the failure each catches)

`tests/unit/integrations-classifier-runtime.test.ts` (expected exit 0):

- **Menu carries reviewed preparation only.** A tool with a current opted-in read review yields a
  `classifier` declaration whose description/template/arguments match the stored entry; a tool with
  no entry, `optIn:false`, `reviewedRisk:null`, a stale fingerprint, or a muted/hidden tool yields
  none. (Catches a menu built from discovery alone.)
- **Server hints are not authority.** A discovered tool with `readOnly:true` but no saved read
  review is not a valid candidate source and is not in the menu. (Catches a false hint becoming
  eligibility; negative control below.)
- **Declaration passes the SDK check.** `checkClassifierEligibility(builtTool)` is `eligible:true`
  for a template using `{status}/{action}/{summary}` and `eligible:false` with a problem for
  `{detail}`. (Catches a declaration the gate would silently drop.)
- **Candidate extraction is bounded and projection-only.** A service list of `{id,name}` or
  `{entity_id,friendly_name}` maps to `{id,label}`; a string list maps id=label; over 50 entries,
  over-length id/label, non-object/array, an `error` envelope, duplicate ids or duplicate labels,
  and a missing id all return null. The returned candidates never contain any other source field.
  (Catches an unbounded list and a leaked remote field.)
- **Candidate cache is owner-scoped, fingerprinted and expiring.** Get after set returns the list
  for the same owner; a different owner, a changed listing fingerprint, or `now` past the TTL
  returns null; `dropConnection` clears only that connection. (Catches a cross-user or stale list.)
- **Refresh only calls reviewed read-only listing tools.** `resolveCandidateListingTool` returns
  null for a missing tool, a write review, a non-opted-in review, and an ordinary-disabled tool;
  `refreshConnectionCandidates` calls the injected port exactly once on success and zero times when
  resolution fails; a `declined`/`unavailable`/`failed` port outcome caches nothing and drops any
  previous list. (Catches a listing call that bypasses review or survives a failure.)
- **Reply precedence and exact strings.** A reviewed template renders from the result; a missing
  placeholder falls through to the envelope summary, and the renderer returns null only when no
  branch can produce a reply; an error/unknown envelope returns the unconfirmed string; an empty
  success summary returns "Action performed successfully." for `performed` and "Read succeeded." for
  `read`; a suppressed/truncated/refused summary passes through unchanged; `detail` never appears.
  (Catches an error rendered as success, a paraphrased suppression, or a leaked remote detail.)
- **Negative control (observed failing):** with the `reviewedRisk === "read"` guard removed from
  `resolveCandidateListingTool`, the false-hint test fails; with the extraction projection replaced
  by returning the raw entries, the projection-only test fails. Restore both, rerun green, and
  record both observations in the PR.
- **No secret/example leak:** the declaration and candidates contain only reviewed/code-authored
  fields; a schema `default`/`example` or a credential header parameter appearing in a listing
  result is never projected into a candidate label. Observe the projection-only test fail with the
  projection removed (above) rather than trust the assertion.

## Verification (unpiped; expected exit code beside each)

```bash
pnpm exec vitest run tests/unit/integrations-classifier-runtime.test.ts > /tmp/cg2b5-unit.log 2>&1; echo "EXIT=$?"   # 0
pnpm typecheck > /tmp/cg2b5-tsc.log 2>&1; echo "EXIT=$?"       # 0
pnpm lint > /tmp/cg2b5-lint.log 2>&1; echo "EXIT=$?"           # 0
pnpm format:check > /tmp/cg2b5-fmt.log 2>&1; echo "EXIT=$?"    # 0
pnpm check:file-size > /tmp/cg2b5-size.log 2>&1; echo "EXIT=$?"  # 0
pnpm build:app-map > /tmp/cg2b5-map.log 2>&1; echo "EXIT=$?"   # 0
scripts/run-gate.sh start            # then background: scripts/run-gate.sh wait --follow   (exit 0)
git diff --check                     # 0
```

No piped gate commands. The named unit file is this slice's own suite; no UAT (no user-facing
surface in this slice; 2b.6 assembles the screen proof).

## Kill gate

If wiring the candidates hook into the synthetic manifest requires the gate to call a tool at
message time (the cache can never be populated by an explicit setup path within this slice), stop
and report to the coordinator before adding a route, a UI or a gateway construction here — the
trigger belongs to the runtime gate composition lane, and this slice should ship the mechanism only.
Owner of that call: the coordinator.

## Out of scope / deferred

- Candidate-editor UI, an explicit refresh endpoint, and the refresh port's gateway implementation
  (runtime gate composition, 3.5/4.x) — D5.
- The reply renderer's call site in `classifier-gate.ts` (chat) — same lane; chat does not depend on
  `@moss/integrations`.
- The real-screen end-to-end proof (2b.6) and any model-call count for preparation (2b.6).
- Risk scoring, gateway authority and approval cards (ruling 7, unchanged); no change to synthetic
  `risk:"outbound"` / `executionPolicy:"auto"`.
- #2893 and #2896 follow-ups.

## Release note (for the PR)

Category: N/A (runtime menu, candidate cache and reply contract; no user-visible surface in this
slice).
