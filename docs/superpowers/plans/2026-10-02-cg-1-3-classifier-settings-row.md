# Lane plan: 1.3 Public rename and classifier settings row

Date: 2026-10-02. Issue: #2892 (epic #2864). Branch: `cg-1-3-settings-row` (from `origin/main`).
Worktree: `~/Jarv1s/.claude/worktrees/cg-1-3-settings-row`. Tier: sensitive, user-facing.

Builds on section 1.2 (merged PR 2886, commit `85f1ee57e`) without changing its contract.
Mockup: `docs/superpowers/mockups/classifier-gate/settings-row.html` (Ben-approved, ruling 13).
Section 1.1 exit: mockup agreed; keep existing background-use privacy disclosures while renaming.

## Premises verified on this branch

- 1.2 storage exists: enum runtime-config key `chat.classifier_gate_mode`, default `off`, admin-wide
  (`packages/settings/src/runtime-config-keys.ts:88`, `packages/shared/src/chat-api.ts:199`).
- Typed admin routes exist: `GET`/`PUT /api/admin/runtime-config/:key`, `on` refused with 409 without
  an approved release (`packages/settings/src/runtime-config-routes.ts:108,128,146`); the activation
  port is wired at the composition root (`packages/module-registry/src/index.ts:1734`).
- No UI reads or writes the gate today: grep of `apps/web/src` for `classifier` returns nothing.
- The row to change is `apps/web/src/settings/settings-ai-sorting-row.tsx`; rendered from
  `AiProvidersPane` (`apps/web/src/settings/settings-ai-admin-pane.tsx:932`).
- `@moss/ui` exports the primitives the mockup uses: `Field`, `FormLabel`, `InfoTip`, `Segmented`,
  `Select`, `Badge` (`packages/ui/src/index.ts:7,40,48,71,73`). `Segmented` already supports a
  per-option `disabled`/`title` (`packages/ui/src/segmented.tsx:17`).
- Existing UI row unit tests assert the old "Sorting model" copy and must move with the rename:
  `tests/unit/settings-ai-sorting-row.test.tsx:113`, `tests/unit/settings-ai-admin-pane.test.tsx:204,251,304`,
  `tests/unit/ai-manifest-sorting-model.test.ts:12,32`.
- UAT seed can sign in as owner and create a provider/model through the real screen, proven by
  `tests/uat/specs/2842-admin-provider-view.uat.spec.ts`.

## Decisions

### D1 Rename is copy-only; internal names stay

- Keep file `settings-ai-sorting-row.tsx`, exports `SortingModelRow`, `SORTING_SERVICE_KEY` (`sorting`),
  storage key and service id untouched.
- Visible copy changes: heading `Sorting model` -> `Classifier`; description -> `Optional model to
handle classification requests.` (mockup line 7); select accessible name `Classifier model`.
- `SYSTEM_ONE_SORTING_NOTE`, `SORTING_DISCLOSURE`, `TRAIL_MARKER_DISCLOSURE` copy preserved
  (background-use privacy), still shown only when a model is bound, exactly as today.

### D2 One shared key constant, no duplicated literal

- Add `CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY = "chat.classifier_gate_mode"` beside `ClassifierGateMode`
  in `packages/shared/src/chat-api.ts` (already the shared home of the mode contract).
- `packages/settings/src/runtime-config-keys.ts` imports and re-exports it from `@moss/shared`
  instead of its own literal (same string; contract unchanged). Add one assertion to
  `tests/unit/runtime-config-registry.test.ts` that the registry entry key equals the shared constant.

### D3 Web client + query key

- `apps/web/src/api/client.ts`: add
  - `getAdminRuntimeConfig(key: string): Promise<GetRuntimeConfigResponse>` -> `GET /api/admin/runtime-config/${encodeURIComponent(key)}`
  - `putAdminRuntimeConfig(key: string, value: string): Promise<PutRuntimeConfigResponse>` -> `PUT` body `{ value }`
- `apps/web/src/api/query-keys.ts`: `settings.adminRuntimeConfig: (key: string) => ["settings","admin","runtime-config",key] as const`.

### D4 Row structure and gate control (mockup-faithful, primitives only)

`SortingModelRow` owns the gate query + mutation; parent props unchanged (`binding`, `models`,
`providers`). Keep the `.rt` Services row shell already in use, so no new classes are invented.

- Header: `Classifier` + `<Badge>` (`amber` "Shadow", `forest` "On", absent when off) +
  `InfoTip` with the mockup t0 copy.
- Description: mockup copy, then existing bound-model disclosures.
- Right column, `jds-field` primitives:
  - `Field` + `FormLabel htmlFor="classifier-model"` "Classifier model" + `Select id="classifier-model"`
    (options/behaviour unchanged, including the unavailable note).
  - `Field` + label "Chat gate" + `Segmented` `ariaLabel="Gate state"` options
    `off|shadow|on` (`Off`, `Shadow`, `On`), plus `InfoTip` with the mockup t2 copy.
    `on` option is `disabled` and carries `title="Available after shadow results are reviewed"`
    unless the saved record already reads `on`. This satisfies "do not expose on as usable before
    the release gate" with no invented release signal.
- Disclosure: exact mockup line `API model: eligible chat messages also go to its provider.` shown
  when a model is bound and the saved gate mode is `shadow` or `on` (the mockup `api` flag pattern).
- Save feedback from the saved record: mutation success writes the returned `config` into the query
  cache and toasts `Classifier gate updated`; the rendered badge/mode always reads the cached record.
  Failure toasts `readError(error)` (drift tone). No optimistic selection.

### D5 App map and manifests (same PR)

- `packages/shared/src/app-map-core.ts` `aiproviders` description: replace the "not shown on any
  screen yet" sentence with the shipped row (model select + Chat gate Off/Shadow/On, On refused until
  an approved release, API disclosure); rename the `Sorting model row` mentions to `Classifier row`
  while keeping the email/News/Sports/Trail Marker behavior sentences truthful.
- `packages/ai/src/manifest.ts`: `ai.classifier_gate_setting` description drops "No screen shows it
  yet" and names the row; `ai.sorting_model` description first word -> `Classifier` (feature id and
  error/remediation ids unchanged).
- `packages/chat/src/manifest.ts`: `chat.classifier_gate` description drops "no screen shows it yet".

## Test plan

Unit (Vitest, jsdom):

- `tests/unit/settings-ai-sorting-row.test.tsx`: extend with a mocked runtime-config client. Cases:
  (a) row renders `Classifier`, never `Sorting model`; (b) `On` disabled while saved mode is `off`
  and `shadow`; enabled when the saved record is `on`; (c) selecting `shadow` calls
  `putAdminRuntimeConfig("chat.classifier_gate_mode","shadow")`; (d) API disclosure appears for a
  bound model under `shadow`, absent when off; (e) model-select/clear still maps to
  `put`/`deleteAiServiceBinding` (existing cases retained).
- Update `tests/unit/settings-ai-admin-pane.test.tsx` label/order assertions to `Classifier`.
- Update `tests/unit/ai-manifest-sorting-model.test.ts` to assert `Classifier` copy.
- `tests/unit/runtime-config-registry.test.ts`: shared-key assertion (D2).

UAT (`tests/uat/specs/classifier-settings.uat.spec.ts`, level `solo-admin`):

1. Sign in as owner, open Settings -> Admin / Setup -> Assistant & AI.
2. Add an Anthropic provider + one manual model through the real UI (pattern from 2842).
3. Assert the `Classifier` row: select the model, reload the page, assert it persisted; clear it,
   reload, assert `Use main model`.
4. Set Chat gate to `Shadow`, reload, assert `Shadow` selected and badge shown.
5. Assert `On` is `disabled`; `fetch` a direct `PUT /api/admin/runtime-config/chat.classifier_gate_mode`
   with `on` and assert `409` (bounded network evidence via the spec's `json()` helper).
6. Re-assert the Classifier row is visible in light, dark and the `sage` theme (set
   `data-color-mode`/`data-theme` on `<html>`), with screenshots per theme.
7. Ordinary chat behavior unchanged: `test.fixme` with the `#1121` citation (no UAT seed can drive a
   real model reply), matching `classifier-tool-menu.uat.spec.ts`.
   Add a `blocking` row to `.claude/skills/coordinate/uat-trigger-map.tsv`:
   `apps/web/src/settings/settings-ai-sorting-row.tsx` -> `tests/uat/specs/classifier-settings.uat.spec.ts`.

Design/checks: `pnpm check:ui-classes` and the invented-class audit from the design-system skill over
`apps/web/src/settings/settings-ai-sorting-row.tsx`; no new CSS file.

## Verification commands (unpiped, expected exit code)

```
pnpm install                                                                 # 0 (done)
pnpm format:check && pnpm lint && pnpm typecheck                             # 0
pnpm test:unit -- tests/unit/settings-ai-sorting-row.test.tsx                # 0
pnpm test:unit -- tests/unit/settings-ai-admin-pane.test.tsx tests/unit/ai-manifest-sorting-model.test.ts tests/unit/runtime-config-registry.test.ts  # 0
pnpm check:ui-classes                                                        # 0
scripts/run-gate.sh start        # then: scripts/run-gate.sh wait --follow (background); read exit
```

UAT + live proof run on an isolated dev instance (never port 1533, never the shared dev database),
owner sign-in, real settings path; evidence posted as a PR comment.

## Kill gate

If the approved disclosure cannot be shown truthfully without changing 1.2's contract, or the `On`
control cannot be kept unusable without inventing a release signal, stop and report to the
coordinator before building (owner: coordinator/Ben). Otherwise build as specified.

## Non-goals

No change to the 1.2 storage key, enum, routes or activation check. No migration. No change to chat
execution. No new CSS classes or primitives. No shadow-record or activity-log UI.
