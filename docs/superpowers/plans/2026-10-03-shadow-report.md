# Shadow report page (#2957) — build plan

- **Issue:** #2957 (task: temporary shadow report page for the chat classifier). Ben's ruling in
  the issue body overrides the spec: no mockup needed, not pretty, not permanent.
- **Spec:** docs/superpowers/specs/2026-10-03-activity-history.md section 11 only.
- **Risk tier:** security (new route reading private per-user records). Owner-only throughout;
  an admin sees only their own records.
- **Lane boundaries:** do not touch the classifier gate itself (lane #2934 owns
  `packages/chat/src/live/classifier-gate*.ts`). One added app-map entry only (lane #2956 also
  edits the app map). No new migration (reads the existing shadow table; never edit 0251/0255).

## 0. Seams check (verified on this branch)

- Shadow table is owner-only with forced RLS, no admin branch:
  `packages/chat/sql/0251_chat_classifier_shadow_records.sql:58-90` (SELECT/INSERT/UPDATE
  owner-only); retention changed to keep-forever plus owner-only DELETE in
  `packages/chat/sql/0255_chat_classifier_shadow_retention.sql:17-29`.
- Repository reads run under the actor data context and rely on RLS for the owner filter, no
  owner parameter: `packages/chat/src/classifier-shadow-repository.ts:238-257` (`listForOwner`).
  New report query follows the same shape.
- Existing isolation test to mirror:
  `tests/integration/chat-classifier-shadow.test.ts:68-95` (B, admin, share recipient see none
  of A's rows). Integration runner: `tsx scripts/test-integration.ts <file>`.
- New server routes must be declared in the chat manifest or boot/test coverage fails:
  `packages/chat/src/manifest.ts:210-290` (routes array), precedent GET-with-context
  `packages/chat/src/routes.ts:631-646`, DELETE shadow precedent
  `packages/chat/src/routes.ts:735-749`, coverage test `tests/unit/chat-route-coverage.test.ts`.
- Settings entry points: amber Shadow badge and gate switch live in
  `apps/web/src/settings/settings-ai-sorting-row.tsx:156-161` (badge) and `:242-244`
  ("On opens after shadow review." line). Intra-settings links use plain anchors:
  `apps/web/src/settings/settings-integrations-classifier.tsx:756`
  (`<a href="/settings?section=assistant">`).
- Admin sections are a closed union plus group list:
  `apps/web/src/settings/settings-page.tsx:84-92` (`AdminSectionId`), `:261-334`
  (`ADMIN_GROUPS`). New section id `shadowreport` extends both.
- App-map scopes are `"user" | "admin"` (`packages/shared/src/app-map-core.ts:8`); admin
  entries precedent at lines 203, 303-351. New entry is scope `admin`.
- Design system: read `docs/design-system.md` before UI work; primitives from `@moss/ui`
  (`Badge`, `Segmented`, `Group`/`Note` as used by the AI panes); spacing `--space-2` between
  controls, `--space-3` between control and text; empty/loading states per the doc, never a bare
  section. Run the invented-class audit before the UI pass.
- Determinism boundary: the page renders from shadow records only. No model call, no summarised
  text, no guidance prompt. Not applicable beyond that statement.

## 1. Phase 1 — report API (backend)

**Files:**

- `packages/chat/src/classifier-shadow-repository.ts` — add `getReportForOwner`.
- `packages/chat/src/routes.ts` — add `GET /api/chat/classifier/shadow-report?days=7|30|90`.
- `packages/chat/src/manifest.ts` — add the route declaration.
- `tests/integration/chat-classifier-shadow-report.test.ts` — new isolation + counting test.

**Decisions:**

- Signature: `getReportForOwner(scopedDb: DataContextDb, options: { readonly days: 7 | 30 | 90 }): Promise<ShadowReport>` with
  `ShadowReport = { days, checked, pickedTool, agreed, comparable, missedTool, disagreements: readonly ShadowDisagreement[] }`
  and `ShadowDisagreement = { id, createdAt, classifierTool: string | null, modelTool: string | null, confidence: number | null }`
  (tool identities as `module.tool` lowercased strings; null classifierTool when the classifier
  declined or named none).
- Counting rules over rows with `created_at >= now() - days`: `checked` = all rows in window;
  `pickedTool` = `decision = 'would_handle'`; `comparable` = `comparison_status` in
  (`match`,`mismatch`); `agreed` = `match`; `missedTool` = `decision != 'would_handle'` AND
  `model_tool_id IS NOT NULL`. No message text leaves the database for counts.
- Disagreements: `comparison_status = 'mismatch'` in window, newest first, cap 50. No
  `message_text` in the response (minimal private data; the numbers answer the brief).
- No owner id parameter anywhere: RLS supplies the filter from the actor context, same as
  `listForOwner`. Route validates `days` against the allowlist (default 30), uses
  `resolveAccessContext` + `withDataContext`, permission `chat.message`... no:
  permission `chat.view` (read of own data; matches the GET privacy/settings precedent).
- Manifest entry: `{ method: "GET", path: "/api/chat/classifier/shadow-report", permissionId: "chat.view" }`
  (no responseSchema, following the `/api/chat/memory/settings` precedent).
- Route and repository carry a short `Temporary (#2957)` comment.

**Test cases (behaviour + why each would fail broken):**

1. Two owners seed match/mismatch/declined rows in window plus stale rows outside it; A's
   report counts exactly A's in-window rows and B's report contains none of A's turn ids.
   Fails if the query filters by anything other than the actor context.
2. Same seed as userB's view must not contain A's rows even when A shares a chat thread with
   B (mirrors the existing share test). Fails if sharing leaks across.
3. RLS-load-bearing demo (scratch, not committed): inside a rolled-back transaction, as an
   owner role run `ALTER TABLE app.chat_classifier_shadow_records NO FORCE ROW LEVEL
SECURITY` plus `DISABLE ROW LEVEL SECURITY`, then re-run case 1 — B's report then
   contains A's rows; roll back. (Dropping the SELECT policy alone proves nothing: forced
   RLS would still deny everyone and B would see none of A's rows, the same result as a
   working filter.) Report the observed fail output in the PR.
4. `chat-route-coverage` unit test passes unchanged (manifest/server parity).

**Phase 1 e2e:** the integration test above, executed and observed passing on the isolated
gate database via the verify-gate skill (never an unscoped run).

## 2. Kill gate (owner: coordinator)

Phase 1 ships alone. Before Phase 2, the coordinator confirms: the counting rules,
the disagreement row fields (no message text), and the default 30-day range. If the
coordinator re-scopes, Phase 2 replans.

## 3. Phase 2 — page, links, map, proof

**Files:**

- `apps/web/src/settings/settings-shadow-report-pane.tsx` — new temporary pane.
- `apps/web/src/settings/settings-page.tsx` — extend `AdminSectionId`, add `ADMIN_GROUPS`
  entry + lazy pane (section id `shadowreport`).
- `apps/web/src/settings/settings-ai-sorting-row.tsx` — Shadow badge becomes a link and the
  "On opens after shadow review." line gains a "See shadow results" link, both to
  `/settings?section=shadowreport`, shown only while the gate is Shadow. The Shadow switch
  option keeps only changing the mode.
- `apps/web/src/api/client.ts`, `apps/web/src/api/query-keys.ts` — `getClassifierShadowReport`
  fetcher + `chat.classifierShadowReport(days)` key.
- `packages/shared/src/app-map-core.ts` — one added entry: id `shadowreport`, scope `admin`,
  path `/settings?section=shadowreport`, description covering the four numbers, the 7/30/90-day
  range, owner-only visibility, and temporary status.
- `tests/unit/settings-ai-sorting-row.test.tsx` — extend: shadow links present in Shadow mode,
  absent otherwise; clicking Shadow still only changes mode.
- `tests/uat/specs/shadow-report.uat.spec.ts` + one row in the UAT trigger map — range
  switch shows numbers, disagreement rows or the honest empty state.

**Decisions:**

- Pane uses `@moss/ui` primitives (`Group`, `Badge`, `Segmented` for 7/30/90) and token
  spacing only; plain rows for disagreements (time, classifier pick, model tool, confidence);
  no detail dialog. Empty state names that no shadow records exist for the viewer in range.
- Page carries a short `Temporary (#2957)` comment.
- Live-path proof on the dev instance (`http://192.168.50.36:5173`, never prod port 1533)
  through the real UI with real shadow data, posted as a `gh pr comment`. If dev holds no
  shadow records for the signed-in user, record the empty state honestly; never fake data. No
  message text in PR evidence. If live proof is impossible, report "code-complete,
  unverified".

## 4. Verification (every command unpiped, expected exit 0)

- `pnpm verify:static > /tmp/vs-2957.log 2>&1; echo "EXIT=$?"` — expected `EXIT=0`.
- `pnpm test:unit > /tmp/tu-2957.log 2>&1; echo "EXIT=$?"` — expected `EXIT=0`.
- Integration report test on the isolated gate database per the verify-gate skill
  (`tsx scripts/test-integration.ts tests/integration/chat-classifier-shadow-report.test.ts`
  inside the skill's scoping) — expected exit 0.
- Pre-push trio plus fresh rebase before every push:
  `pnpm format:check && pnpm lint && pnpm typecheck`, then
  `git fetch origin main && git rebase origin/main`.

## 5. Open questions (none blocking Phase 1)

- None. The only judgement call (disagreement rows without message text) is covered by the
  kill gate.
