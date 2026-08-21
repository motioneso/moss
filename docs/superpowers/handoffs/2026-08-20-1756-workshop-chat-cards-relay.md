# Relay — #1756 Workshop chat cards (Group E)

**Handoff to read first:** `docs/coordination/handoff-1756-workshop-chat-cards.md` (short, has all
the links: spec, mockups, plan section, coordinator pane label, exit criteria).

**Plan section (read only this):** the plan lives on a different branch/worktree because it's
still being written on its own branch. Read Group E from:
`~/Jarv1s/.claude/worktrees/1739-stage1-plan/docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`
lines 1980 to end (Tasks 25-28). Do not read the rest of that file — it's other groups' work.

**Worktree:** `~/Jarv1s/.claude/worktrees/1756-workshop-chat-cards`, branch `1756-workshop-chat-cards`.
`node_modules` already installed — skip `pnpm install`.

## Ground truth learned this session (don't re-derive)

- This worktree is fresh off `main`. Groups A-C (#1752/#1753/#1754) have **not landed** — none of
  `ModuleBuildPlan`, `writeModuleBuildPlan`, `module_builds` table, or a build-step state machine
  exist anywhere in the repo yet. Confirmed by full-repo grep, not assumption.
- `app.external_modules` (packages/settings/sql/0152, 0157, 0158, 0162, 0171) has no draft status
  and no owner column today — only `enabled`/`disabled`, admin-scoped. "Draft" is Group B's
  schema work, not landed. **Do not invent a migration for draft/owner status here** — that's
  Group B's table to define; adding our own risks a real migration collision at merge time.
  Given this, Task 26's `discardDraft` backend (DELETE /api/admin/modules/:id scoped to
  draft+owner) is **blocked on Group B landing**, same as the plan-approval card's real data is
  blocked on Group C — treat it the same way the handoff already tells you to treat #1754: build
  the banner component's UI shell now against fixture props, note the backend is blocked, wire it
  when Group B is visible.
- Existing "raised card in transcript" precedent (what the plan means by "the frontend grounding
  fork found"): `apps/web/src/chat/action-request-card.tsx`, wired into the transcript by
  `apps/web/src/chat/message-row.tsx`'s `RecordRow` (special-cases `record.kind === "action_request"`).
  Same wiring pattern applies once a `plan_approval` record kind exists (not yet — Group C not
  landed, so nothing wires `PlanApprovalCard` into a live transcript yet; it stands alone).
- Chat drawer is `apps/web/src/chat/chat-drawer.tsx`, **overlay-only today** — fixed-position
  `<aside class="chatd">`, no docked/inline mode, no prop for one. Task 27's "docked, scoped
  drawer" is new layout work on top of this file (or a wrapper around it), not a tweak.
- Component test convention: Vitest, `// @vitest-environment jsdom` + `react-test-renderer`'s
  `create`/`act` (no `@testing-library/react` in this repo). **Important gotcha burned an hour**:
  `create(...)` must be wrapped in `act(() => { ... })` or `renderer.toJSON()` silently returns
  `null` with no thrown error — see `tests/unit/plan-approval-card.test.tsx`'s `renderCard()`
  helper for the working pattern, copy it.
- Design system: `jds-card__meta` (used in the `draft.html` mockup) is **not a real defined class**
  — checked `packages/ui/src/styles/components-core.css` and `apps/web/src/styles/*.css`, it
  isn't there. Don't copy it from the mockup verbatim; use a plain paragraph with a local
  layout-only class instead, or check `packages/ui/OPTIONS.md` for the real equivalent metadata-line
  pattern before inventing one. Run the invented-class audit (see `design-system` skill) before
  committing any component that touches the mockups' classes.
- Real jds primitives confirmed present and safe to use: `jds-card`, `jds-card--raised`,
  `jds-eyebrow(--gold/--muted)`, `jds-btn(--primary/--secondary/--quiet/--sm)`, `jds-badge*`,
  `jds-indicator(--ready/--live)`, `jds-rail`/`jds-rail--gold`/`jds-rail-row` (real grid primitive,
  3px/1fr), `jds-card-title(--heavy)`, `jds-governor*` (a second, different approval-card pattern
  used in `chat.html`'s mockup for "Start building?" — distinct from the plan-approval card).
- Admin module routes convention: `packages/settings/src/routes-modules.ts`,
  `registerModuleRoutes(server, ctx)` — `server.delete<{ Params: { id: string } }>(...)`,
  `assertAdminUser` first inside `withDataContext`, `handleRouteError` catch, `HttpError(404/409)`.
  Note: this file's existing pattern is **admin-gated**; draft deletion is *owner*-gated per the
  plan, so a new discardDraft route needs its own auth check (caller owns the draft), not
  `assertAdminUser` — don't copy that call in.
- Shared checkout: this worktree is dedicated to #1756 (other parallel groups are in their own
  worktrees: `1755-workshop-page`, `1739-stage1-plan`, `1752-module-discovery-holder`). `git status`
  was clean before every commit here — still follow the `shared-checkout` skill's explicit-path
  commit discipline regardless.
- Coordinator pane: label `Coordinator`, confirmed live via `herdr pane list` this session at
  pane `w1:pH4`. **The session id in the original handoff doc
  (`01d11bc2-ed28-440a-9f95-3bf53f0046c7`) is stale** — the live session id was
  `fbacd483-baf3-47c8-aacf-66a51c6ebd7b` as of this relay. Always re-resolve by label, never trust
  a cached id.

## Done (committed)

- Task 25 — `feat(#1756): the plan-approval card in the chat drawer` (commit `5657153e1`):
  - `apps/web/src/chat/plan-approval-card.tsx` — `PlanApprovalCard` component + exported
    `ModuleBuildPlan` type (five-field shape matching what Task 14 will produce:
    `whatItDoes`, `whatItReaches: string[]`, `whatItKeeps`, `whenItRuns`,
    `roughCost: { time, budgetCents }`). Props: `plan`, `onBuildIt`, `onNotYet`, `superseded?`
    (defaults false; when true renders as plain text, no card, no buttons).
  - `tests/unit/plan-approval-card.test.tsx` — 3 passing tests (all five lines render, both
    buttons call their own callback, superseded renders as plain message with zero buttons).
  - `apps/web/src/styles/kit-chat.css` — added `.plan-card__rows/__row/__actions` and
    `.plan-card--superseded/__superseded-line` (layout-only, existing token vars, no invented
    jds- classes — this file's classes are intentionally NOT jds-prefixed, matching the
    `action-request-card` precedent already in this file).
  - Ran: `pnpm vitest run tests/unit/plan-approval-card.test.tsx` — 3/3 pass.
  - **Not yet run**: the invented-class audit against this new file (do it now, first thing,
    before touching anything else — it's one command, see design-system skill).

## Not started (Tasks 26, 27, 28)

- **Task 26**: Draft banner component (`{ moduleId, whatItReaches, whatItKeeps }` props +
  `onShip`/`onAskForChange`/`onSeeCode`/`onThrowAway` callbacks, per `draft.html` mockup's single
  raised card). Suggested location: new `apps/web/src/workshop/` directory (matches the spec's
  "Workshop" feature name; #1755 building the Workshop *page* there in its own worktree is a
  plausible neighbor, not a literal file collision — flag to coordinator only if you actually see
  a shared-component collision). `discardDraft` backend: **blocked on Group B's draft/owner schema
  landing** — build and test the banner component only; note the block explicitly in the PR,
  matching how the handoff already tells you to treat #1754.
- **Task 27**: Docked chat drawer mode + `classifyDraftChangeRequest` classifier. The classifier
  is pure/injectable (`deps.writeModuleBuildPlan`-shaped, fakeable in tests per the plan's Testing
  Decisions — same pattern as Task 14's fake, do NOT wait for the real implementation to land).
  Docked-vs-overlay layout: new CSS/prop on top of `chat-drawer.tsx`, two-pane at desktop width,
  normal overlay at the mobile breakpoint (do NOT copy the mockup's always-stacked layout — that's
  explicitly a static-file limitation per the issue text and an existing memory note
  `feedback-phone-chat-stays-a-drawer.md`). The "put the last change back" mechanism: search
  `scripts/module-install.ts`'s `installModule` — confirmed this session it has **no existing
  swap/park-prior-version mechanism** (checked via grep for swap/backup/rollback/park/archive,
  nothing relevant). Per the plan's own instruction: if genuinely absent, **stop this one sub-step
  and report the gap rather than inventing a new versioning system** — don't silently build one.
- **Task 28**: design-system audit across all Group E components, fix any invented class, commit.

## Exit criteria reminder (from the handoff, unchanged)

Full gate green on an isolated gate DB (`verify-gate` skill, never run foundation gate raw).
Design-system audit clean. Live-path proof via `gh pr comment` on a live dev instance (this is a
real UI surface). PR open, rebased on `origin/main`, referencing #1756. Never touch
`docs/coordination/`, the board, or merge anything.
