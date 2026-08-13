# Plan: #1325 — provider picker collects credential before create

**Issue:** #1325 (`bug`). **Spec:** none — handoff
(`docs/coordination/handoffs/2026-08-13-1325-provider-credential-picker.md`, on the
`coord/overnight-20260810` branch, commit `ccc9b6dee`) explicitly waives a separate spec doc for
this scoped fix and carries Fable's binding design-fork ruling instead. **Risk tier:** `security`.
**Branch:** `1325-provider-credential-picker` (off `origin/main`). Single phase — one component,
one route guard left untouched, no architectural fork left open.

## 0. Gates

- Issue #1325, `bug` label, confirmed open, body verified today (see seams below).
- Fable's ruling (handoff doc, binding, not re-litigated): **Option 3** — the picker collects the
  credential the catalog entry's auth method needs (API key, optionally Base URL) and sends it as
  `credentialPayload` on create. The server 400 guard stays exactly as-is. Rejected: sending `{}`
  (false "stored" status); a nullable-column migration (bigger change for a worse create-then-edit
  flow).

## 1. Seams check (file:line, verified on this branch 2026-08-13)

- `packages/ai/src/routes.ts:754-759` (`parseCreateProviderBody`) — throws `400` when
  `authMethod !== "cli"` and `value.credentialPayload === undefined`. Untouched by this plan; it's
  the correct fail-closed guard per the ruling. Accepts any JSON object (line ~772,
  `requiredJsonObject`) — does not itself require a non-empty `apiKey`, so the client is the only
  place that can stop a "stored" lie.
- `apps/web/src/settings/settings-ai-admin-pane.tsx:62-74` (`PROVIDER_CATALOG`) — 7 entries, 3
  `authMethod: "cli"` (Anthropic, OpenAI, Google), 4 `authMethod: "api_key"` (Mistral, Local
  (Ollama), OpenAI-compatible, Custom). All 4 api_key kinds map to `openai-compatible` fetch
  handling server-side (`packages/ai/src/provider-validation.ts:85-90`), so one credential shape
  (Base URL optional, API key required) covers all 4 — no per-kind branching needed.
- `apps/web/src/settings/settings-ai-admin-pane.tsx:587-600` (`createMutation`) — today calls
  `createAiProvider({ providerKind, displayName, authMethod })`, never `credentialPayload` or
  `baseUrl`. This is the exact defect: `packages/ai/src/routes.ts:759` rejects every api_key-catalog
  click.
- `apps/web/src/settings/settings-ai-admin-pane.tsx:763-789` (picker JSX, `.provpick` grid) — each
  catalog button's `onClick` calls `createMutation.mutate(option)` directly with no intermediate
  state; `disabled={has}` is the only per-item state today.
- `apps/web/src/settings/settings-ai-admin-pane.tsx:331-366` — the Edit pane's non-CLI branch is
  the field pattern to reuse verbatim: `Field label="Base URL"` + `input.jds-input` (optional,
  placeholder `https://api.anthropic.com`), `Field label="API key"` + `input.jds-input
type="password"` (placeholder `sk-…`), a `Button variant="secondary"` gated
  `disabled={!apiKey.trim() && !baseUrl.trim()}`. The picker's new form reuses `Field`/`Segmented`-
  adjacent primitives already imported at `:38` — no new `@moss/ui` component, no new CSS
  primitive.
- `apps/web/src/settings/settings-ai-admin-pane.tsx:234-245` (`ProviderCard`, `.prov__auth` line) —
  the issue's second defect: `provider.hasCredential` is always `true` for any non-cli provider
  because `encrypted_credential` is `NOT NULL` (`packages/ai/src/repository.ts:1681`,
  `packages/ai/sql/0013_ai_module.sql:45`), so the `"No credential"` branch is dead. Only this one
  read site is in scope (named directly by the issue); the Edit-pane placeholder ternary at `:348`
  (`provider.hasCredential ? "•••••••• (stored)" : "sk-…"`) is a second, unnamed instance of the
  same staleness — left as a fast-follow note (ledger below), not fixed here, to keep the diff to
  what the issue and ruling actually name.
- `packages/shared/src/ai-types.ts:200-208` (`CreateAiProviderConfigRequest`) — `baseUrl?: string |
null`, `credentialPayload?: Record<string, unknown>`, both already optional and already used by
  the Edit-pane `onUpdate` path (`:732-741`) — no shared-type change needed.
- `tests/uat/specs/1270-provider-signin.uat.spec.ts:120-130` — comment block placed by the #1270
  author names this exact gap and says explicitly: "Restore the API-key half as the regression test
  when #1325 is fixed." That test file is the correct home for this plan's UAT coverage, not a new
  file.
- `tests/unit/settings-ai-admin-pane.test.tsx` (27 lines today) — only a static `renderToString`
  smoke test, no interaction. `tests/unit/settings-ai-pane.test.tsx:1-15` establishes the
  interactive pattern this repo uses for a React-Query mutation form: `// @vitest-environment
jsdom` + `react-test-renderer`'s `act`/`create`, `vi.mock("../../apps/web/src/api/client.js", ...)`
  providing every export the pane imports, `renderer.root.findByProps({ "aria-label": ... })` to
  drive real `onChange`/`onClick` handlers, a `flush()` helper awaiting one microtask tick under
  `act`. This plan's Task 3 follows that pattern in `settings-ai-admin-pane.test.tsx`.
- `docs/DEVELOPMENT_STANDARDS.md:34-58` (Live-Path Gate, current) — screenshots are explicitly
  **not** required or reviewed ("Do not request, capture, attach, or review screenshots for this
  gate"); the gate wants a `gh pr comment` with the e2e UAT run, exit code, and assertions. This
  supersedes the handoff doc's "screenshot on the PR" line (that handoff predates commit
  `2852a12c3`, "drop screenshot requirement from Live-Path Gate," docs-only, already on `main`).
  Plan follows the current doc; no new `shot()` calls added to the UAT spec for this change, though
  existing `shot()` calls already in that file are left as-is (harmless, not this plan's scope).

## 2. Determinism boundary

N/A — no model output anywhere on this path. The picker collects user-typed text (API key, base
URL) and forwards it verbatim to `POST /api/ai/providers`, exactly the same trust boundary the Edit
pane's existing credential field already crosses. No chat turn, no model-authored value.

## 3. Tasks

### Task 1 — picker collects Base URL + API key for api_key catalog entries before create

File: `apps/web/src/settings/settings-ai-admin-pane.tsx`.

- Add local state: `const [credentialFor, setCredentialFor] = useState<(typeof
PROVIDER_CATALOG)[number] | null>(null)`, `const [pickBaseUrl, setPickBaseUrl] =
useState("")`, `const [pickApiKey, setPickApiKey] = useState("")`.
- Change `createMutation`'s `mutationFn` signature from `(option: (typeof
PROVIDER_CATALOG)[number])` to `(input: { option: (typeof PROVIDER_CATALOG)[number]; baseUrl:
string; apiKey: string })`. Body:
  `createAiProvider({ providerKind: input.option.kind, displayName: input.option.label, authMethod:
input.option.authMethod, baseUrl: input.baseUrl.trim() || undefined, ...(input.option.authMethod
=== "cli" ? {} : { credentialPayload: { apiKey: input.apiKey.trim() } }) })`. `onSuccess` also
  resets `setCredentialFor(null)`, `setPickBaseUrl("")`, `setPickApiKey("")` alongside the existing
  `setPick(false)` / `invalidate()` / toast (toast still reads `input.option.label`, update the
  destructured param name accordingly).
- Picker grid button (`:770-780`) `onClick`: if `option.authMethod === "cli"`, call
  `createMutation.mutate({ option, baseUrl: "", apiKey: "" })` (unchanged one-click behavior for
  the 3 CLI entries). Else, `setCredentialFor(option)` (opens the inline form; does not create yet).
  Keep `disabled={has}` as-is.
- Below the grid, when `credentialFor` is non-null, render an inline form reusing the exact field
  pattern from `:333-365` (`Field label="Base URL"` + `.jds-input`, `Field label="API key"` +
  `.jds-input type="password"`), plus two buttons: `Button variant="secondary"` "Add", `disabled={!
pickApiKey.trim()}` (client-side empty-key block, per handoff step 5), `onClick={() =>
createMutation.mutate({ option: credentialFor, baseUrl: pickBaseUrl, apiKey: pickApiKey })}`; and
  `Button variant="quiet"` "Cancel", `onClick={() => { setCredentialFor(null); setPickBaseUrl("");
setPickApiKey(""); }}`. Heading text: `Add ${credentialFor.label}`.
- No new CSS class needed — `Field`, `.jds-input`, `Button` are all already-imported primitives: a
  `<div className="provpick__cred">` wrapper reusing `.provcfg` spacing rules
  (`apps/web/src/styles/settings-panes.css`) is the only new class, and it's layout-only (flex
  column, gap) — same shape as `.provcfg__cli` already in that file. Confirm against the file at
  edit time; add only if the default `Field` stacking doesn't already read cleanly.

**Test (unit, TDD-first):** `tests/unit/settings-ai-admin-pane.test.tsx` — new `describe` block.
Mock `../../apps/web/src/api/client.js` per the established pattern (`settings-ai-pane.test.tsx`
model): `listAiProviders` (empty), `listAiModels` (empty), `listAiServiceBindings` (empty),
`getChatModelOverrideSettings` (inert), `getPersonaSettings` (inert, for `useAssistantName`),
`createAiProvider` as a `vi.fn()` spy resolving `{ provider: <minimal AiProviderConfigDto> }`.
Cases, each stated as behavior that would fail against today's `main`:

1. Clicking "Mistral" in the picker does **not** call `createAiProvider` immediately (today's bug:
   it does, and the server 400s) — it opens the inline form instead. Assert via `findByProps({
"aria-label": "API key" })` becoming findable only after the click.
2. With the Mistral form open and API key left empty, the "Add" button
   (`findByProps({ children: "Add" })` or an `aria-label` if one is added) is `disabled`. Fails
   against a naive "send `{}`" implementation, which would enable it unconditionally.
3. Filling API key `"sk-test-123"` and clicking "Add" calls `createAiProvider` with
   `providerKind: "openai-compatible"`, `authMethod: "api_key"`, `credentialPayload: { apiKey:
"sk-test-123" }`. This is the regression assertion for #1325's `400` — fails against `main`,
   which never sends `credentialPayload` at all.
4. Clicking "Anthropic" (a `cli` catalog entry) still calls `createAiProvider` immediately with no
   `credentialPayload` key present at all (not even `credentialPayload: undefined` — omitted) —
   proves the CLI one-click path is unchanged.

**Verification:**

```bash
pnpm --filter @moss/web exec vitest run ../../tests/unit/settings-ai-admin-pane.test.tsx > /tmp/t1.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`. (Confirm the actual invocation against root `package.json` / `vitest.config.ts`
before running — this repo's root suite may run these tests from the repo root instead; adjust the
command, keep the unpiped `echo "EXIT=$?"`.)

### Task 2 — retire the dead "No credential" branch

File: `apps/web/src/settings/settings-ai-admin-pane.tsx:240-244`.

Change:

```tsx
{
  provider.authMethod === "cli" ? `${provider.displayName} CLI` : "API key stored";
}
```

(Drops the `provider.hasCredential` ternary — always true for a non-cli provider per the `NOT
NULL` column, so the previous `: "No credential"` branch was unreachable dead code, exactly as the
issue's "second, related defect" section describes.)

**Test:** covered by Task 1's UAT addition (Task 4) asserting the created Mistral card reads
"API key stored" — no separate unit test needed for a one-line literal simplification.

**Verification:**

```bash
grep -n "No credential" apps/web/src/settings/settings-ai-admin-pane.tsx; echo "EXIT=$?"
```

Expected: `EXIT=1` (grep finds nothing).

### Task 3 — regression coverage in the existing #1270 UAT spec

File: `tests/uat/specs/1270-provider-signin.uat.spec.ts`.

- Replace the `DELIBERATELY NOT COVERED` comment block (`:120-130`) with a new `test(...)` in the
  same file (shares `signIn`/`skipOnboarding`/`openAssistantAndAiSettings`/`addProviderFromPicker`/
  `providerCard` helpers already defined at `:34-88` — no new helper file).
- Flow: `signIn` → `skipOnboarding` → `openAssistantAndAiSettings` → click "Add provider" → click
  "Mistral" (`exact: true`, per the existing helper's own comment about substring collisions) →
  assert the inline credential form is visible (`getByLabel("API key")`) → assert the "Add" button
  is disabled with the API key field empty → fill a fake key (e.g. `"sk-uat-test-not-real"`, no
  real provider call happens for `openai-compatible` model discovery against a fake key — a failed
  discovery fetch is fine, this UAT proves _provider creation_, not real API connectivity) → click
  "Add" → assert `providerCard(page, "Mistral")` becomes visible and its `.prov__auth` text reads
  "API key stored" (not an error toast, not "No credential") → assert `page.getByText("Add a
provider")` (or the form) is gone (picker closed on success, matching `onSuccess`'s
  `setPick(false)`).
- This is the assertion that fails on `main` today: `main` shows an error toast and adds nothing
  (per the issue body and the comment block being replaced).

**Verification (the phase's e2e — run against a live dev instance per the live-path gate):**

```bash
pnpm playwright test tests/uat/specs/1270-provider-signin.uat.spec.ts --config playwright.uat.config.ts > /tmp/uat-1325.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`. (Confirm exact UAT runner invocation — `verify-gate`/UAT skill conventions in
this repo route through `run-uat.ts`, not a bare `playwright test`; use whatever that skill
specifies, keep the unpiped exit-code pattern.)

## 4. Kill gate

None needed at this size — one component, one existing test file gaining cases, one existing UAT
spec gaining one test, zero new files, zero schema/migration/route changes. If Task 1's jsdom
mutation-mocking turns out to need more client-module exports than expected and balloons past a
straightforward mock block, that's a signal to escalate to the coordinator before continuing, not a
reason to skip the test.

## 5. Full-phase verification (after all 3 tasks committed)

```bash
grep -rhoE "jds-[a-zA-Z0-9_-]+" apps/web/src/settings/settings-ai-admin-pane.tsx | sort -u > /tmp/used.txt
grep -rhoE "\.jds-[a-zA-Z0-9_-]+" apps/web/src/styles/ | sed 's/^\.//' | sort -u > /tmp/defined.txt
comm -23 /tmp/used.txt /tmp/defined.txt; echo "EXIT=$?"
```

Expected: no output lines (any new `provpick__cred`-style class added in Task 1 is module-local,
not `jds-*`, so this audit targets only `jds-*` usage — a separate check, not shown, for any new
non-`jds-*` class actually having a CSS definition, same `comm` shape against
`settings-panes*.css`).

Then the full local gate on an isolated gate DB (`verify-gate` skill — never improvised), the
pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`, fresh rebase on `origin/main`),
before `coordinated-wrap-up`. PR tagged `[SECURITY]` per the handoff's risk tier — Ben's explicit
merge sign-off required, per that tier, on top of adversarial Opus QA.

## Rulings ledger

- **Option 3 (Fable, binding)**: picker collects credential before create; server guard untouched.
  Not re-litigated here — see handoff doc for the full rejected-alternatives list.
- **One credential shape covers all 4 api_key catalog entries** (Base URL optional, API key
  required): all 4 kinds share `openai-compatible`-style fetch handling server-side
  (`provider-validation.ts:85-90`), so no per-kind field branching is needed in the picker form.
- **Scope boundary on the "always-true `hasCredential`" tidy-up**: only `ProviderCard`'s
  `.prov__auth` line (issue-named) is fixed here. The Edit-pane placeholder ternary at `:348` is the
  same staleness but wasn't named by the issue or the ruling — left as a fast-follow, not bundled
  into this diff, to keep the change reviewable against what was actually asked for.
- **No new UAT spec file**: `tests/uat/specs/1270-provider-signin.uat.spec.ts` already has a
  comment block placed by the #1270 author pointing at this exact gap and naming this file as where
  the regression test belongs. Honor that pointer instead of fragmenting coverage.
- **No screenshot captured for this change's live-path proof**: current
  `docs/DEVELOPMENT_STANDARDS.md` Live-Path Gate (post `2852a12c3`) explicitly excludes screenshots
  from the gate; the handoff doc's "screenshot on the PR" line is stale against that doc. Following
  the doc (source of truth) over the handoff's wording.
- **Fable review (APPROVED, no fork)**: every seam citation independently checked out. Two
  additional facts confirmed, worth citing in the PR body: (1) `routes.ts:199-214` wraps
  `discoverAndPersistModels` in try/catch ("Soft-fail: leave the provider with no auto-discovered
  models"), so Task 3's fake-key UAT create genuinely succeeds and the card renders — not an
  assumption; (2) `credentialPayload.apiKey` matches both the server reader
  (`provider-validation.ts:70`) and the existing Edit-pane update shape (`:732-738`).
- **Fast-follow, non-blocking (Fable note)**: "Local (Ollama)" is catalogued `authMethod: "api_key"`,
  so the required-key gate forces Ollama users to type a dummy key even though Ollama servers ignore
  auth headers. Pre-existing modeling (the Edit pane has the same shape already) and consistent with
  the one-credential-shape ruling — noted alongside the `:348` placeholder fast-follow, not fixed in
  this pass.
