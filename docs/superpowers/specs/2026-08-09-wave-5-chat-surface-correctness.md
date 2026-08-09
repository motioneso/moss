# Wave 5 — The chat surface a real user actually gets

**Date:** 2026-08-09
**Status:** Approved by Ben on 2026-08-09 (#1260 fork settled — see "Design forks — settled").
**Tracking epic:** #1470 (batches "Runtime and data correctness" + "UI, accessibility, and focused polish"); serves #983
**Issues:** #1449 (lane A) · #1259 + #1260 (lane B) · #1254 (lane C) · #1255 + #1451 (lane D)
**Grounded on:** `origin/main` = `c8946358f`

## Context

Four of these are `sev:major` and share one theme: a feature that is _built_ and does not reach the
person using it.

- #1449 — #1253's approval-card rehydration is dead code for every user who is not inside a module
  context, because the shell passes no surface. Proven live 2026-08-06: zero requests to
  `GET /api/ai/assistant-actions`.
- #1259 — the persona handed to the CLI engine is keyed by `userId` alone, so a module screen
  receives the chat drawer's app-map instructions on top of the module's own guidance.
- #1260 — module-authored guidance is HTML-escaped, so a module reads `&lt;module_control&gt;` while
  the control turn it later receives is spelled `<module_control>`.
- #1254 — the approval card asks a person to consent to `job-search.profile.update`.
- #1255 — the drawer's availability gate reads CLI install state, not "is there a model that can
  serve this capability for this user".
- #1451 — a user with a custom assistant name sees the fallback for one frame on every page load.

**Grounding gap:** #1259 and #1260 both cite `docs/architecture/model-instruction-stack.md`. That
file does not exist on `c8946358f`. Lane B must re-derive the persona composition seams from code
before planning and record them in the plan; do not treat the issue bodies' line references as
verified.

## Goals

- The default "Chat with Jarvis" drawer rehydrates pending approval cards after a reload.
- Persona composition is keyed by `(userId, surface)`; the app-map block is composed only for
  `drawer`.
- A module can name the host-owned control tags it is told to expect, without weakening injection
  defence on module-authored text.
- An approval card names the action in plain English.
- The drawer's availability reflects model availability, not CLI install lifecycle.
- A custom assistant name is correct on first paint.

## Non-goals

- No chat redesign, no new surface type, no change to the `surface` param's existing threading
  (JS-00, #1231 already delivered it).
- No change to what module-authored text is _neutralized_ against injection — #1260 narrows the
  escape, it does not remove it. This wave must not undo #1136's boundary.
- No new approval-policy behaviour. #1249 (`risk: "outbound"`) is a different wave.
- No prefetch framework, suspense architecture, or SSR introduction for #1451 beyond the single
  chosen mechanism.
- #1429 (the #1327 action-row CSS/e2e fix) is deliberately excluded — it shares `apps/web` and would
  collide.

## Lanes, tiers, and collision map

`apps/web` is one app, so its lanes are separated by **file ownership**, and the merge order below is
load-bearing. Lanes A, C, and D each own distinct files; no two lanes edit the same file.

| Lane | Issues       | Tier          | Owned files (exclusive)                                                                                                                              | Intended seam                                                                                                                                                                                       |
| ---- | ------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------- |
| A    | #1449        | **sensitive** | `apps/web/src/shell/app-shell.tsx`, `apps/web/src/chat/use-chat-stream.ts`                                                                           | Shell passes no surface (`app-shell.tsx:142`); rehydration effect gated `if (!surface                                                                                                               |     | !enabled)` (`use-chat-stream.ts:133`). Fix at the **caller**, and test at the caller. |
| B    | #1259, #1260 | **sensitive** | `packages/chat/src/live/*` (persona composition, `prompt-safety.ts`), `packages/chat/src/live-routes.ts`, plus the job-search module's guidance text | Key persona by `(userId, surface)`; introduce a host-defined **non-tag control token** and rewrite job-search's guidance to use it. `sanitizeExternalData` (`prompt-safety.ts:34-36`) is unchanged. |
| C    | #1254        | **sensitive** | `packages/module-sdk/src/index.ts`, `packages/shared/*-api.ts`, the approval-card component                                                          | Optional manifest-declared plain-English action label; render it, fall back to the tool name.                                                                                                       |
| D    | #1255, #1451 | **routine**   | `apps/web/src/api/use-assistant-name.ts`, the drawer availability gate                                                                               | Gate on the router's capability answer; prefetch/seed the persona query.                                                                                                                            |

**Tier rationale:** lane A changes runtime chat-shell behaviour on a consent surface; lane B changes
the module→model instruction contract (cross-module contract change) and the prompt-safety boundary;
lane C adds a field to the declared module manifest, which is public API. All three hit `sensitive`.
Lane D is isolated UI with no contract or data change → `routine` — but the Live-Path Gate still
binds it.

Lane B is _not_ a `security` tier despite touching `prompt-safety.ts`: under the settled non-token
design the blanket escape at `prompt-safety.ts:34-36` is unchanged and nothing is ever unescaped, so
no new untrusted-text path is created. **Standing guard: if lane B's implementation ends up
unescaping any module-supplied substring, it has left the approved design — stop, re-tier to
`security`, and escalate rather than proceeding.**

## Resolved decisions

- **#1449** — fix the caller, not the hook. The existing `tests/unit/use-chat-stream.test.tsx` is
  green precisely because it supplies a surface; the regression test must assert at the shell level
  that the default drawer fetches pending action requests on mount.
- **#1260 — SETTLED (Ben, 2026-08-09): a non-tag control token. No tag-escaping allowlist.**
  `packages/chat/src/live/prompt-safety.ts:34-36` — `sanitizeExternalData` is a blanket `& < >`
  escape. It stays a blanket escape with **no exceptions**. Modules reference the control channel by
  a token that is never a tag, so a module's guidance and the control turn it later receives spell
  the channel identically without any unescaping.
  - _Why this over the alternatives:_ unescaping a closed host-owned tag set after sanitizing needs
    no module rewrite, but it carves an allowlist into a security boundary that every future tag must
    remember to join — exactly the kind of exception that silently rots. One rule with no exceptions
    is the cheaper thing to keep correct.
  - **This makes lane B larger, by decision.** Rewriting the job-search module's guidance text to use
    the token is **in scope for lane B and ships in the same PR** — job-search is the only module
    relying on tag-name matching today, so the cost is bounded and paid once.
  - The token is **host-defined**, never module-supplied. A module may reference it; a module may
    never introduce one.
  - Lane B therefore stays `sensitive`, not `security`: no module-supplied substring is ever
    unescaped, and no new untrusted-text path is created.
- **#1254** — the manifest field is **optional**, with the tool name as fallback. A required field
  would break every installed external module.
- **#1259** — compose the app-map section only for `drawer`. Module surfaces get the module's own
  guidance and nothing else.

## Design forks — settled

**#1260 is settled** (non-tag control token; job-search guidance rewritten in the same PR; sanitizer
keeps one rule with no exceptions — see Resolved decisions). Two smaller forks remain for the lanes'
own plans to resolve from code, not for Ben:

1. **#1451's mechanism.** Prefetch on the app shell's query client, a suspense boundary, or a
   server-seeded value. Take the **prefetch** unless lane D's seams check shows it cannot eliminate
   the first-paint frame — it is the smallest blast radius of the three.
2. **#1255's source of truth.** Exposing "is there a model that can serve this capability for this
   user" to the browser is either a new endpoint or an extension of an existing one. Lane D picks
   from the existing route surface and must prove the answer is boolean-shaped — it leaks no
   provider, model, or credential identity the user is not already shown.

## Exit criteria

- #1449: **live proof** — a pending approval row seeded, sign in, open the default drawer, reload,
  reopen; the card is present and the API log shows the `GET /api/ai/assistant-actions` request.
  Plus a shell-level test that fails if the default drawer stops fetching.
- #1259: a test proves a module-surface turn's persona contains no app-map instructions and a drawer
  turn still does.
- #1260: a test proves a module's guidance references the control channel in the exact spelling the
  control turn uses (via the token, with no unescaping anywhere); a test proves `sanitizeExternalData`
  still escapes `& < >` in module-authored prose with no exceptions; and job-search's guidance text is
  rewritten to the token in the same PR, with live proof that its onboarding flow still responds to
  `open` / `critique` / `approved`.
- #1254: a test proves a declared label renders and an undeclared tool falls back to its name; live
  proof shows a human-readable approval card.
- #1255: a test proves the gate flips with model availability, not install state, in both directions.
- #1451: live proof on a dev instance with a custom assistant name — no frame shows the fallback.
  A unit test will not reproduce this; do not accept one as the evidence.
- No lane crosses another lane's owned files.

## Dependency and merge order

Lanes A, B, C, D build in parallel. Merge **A → C → D → B**: A is the proof-heaviest and unblocks
#1250/#1253's UI-level close, C and D are additive, B is the largest contract change and takes the
freshest rebase. Every lane rebases and re-QAs after each earlier merge.

Lane A additionally **unblocks #1253 and #1250's UI-level close** — the coordinator should re-check
both after A merges rather than assuming they closed with it.

## Hard invariants honored

- **Private by default / no admin bypass.** No lane changes an RLS predicate or a visibility rule.
  #1449 makes an owner-scoped fetch actually run; it does not widen what it returns.
- **Secrets never escape.** #1255's new availability answer must be a boolean-shaped capability
  answer, not a provider/model/credential disclosure. #1260 must not create a path for module text
  to smuggle host-owned framing — the closed tag set (or token) is host-defined, never
  module-supplied.
- **Metadata-only job payloads.** No lane changes a pg-boss payload.
- **Module isolation.** #1254 and #1260 change the declared manifest/guidance contract only.
- **Manifest routes and schemas are public API.** #1254's field is additive and optional.
- **Never edit an applied migration.** No lane adds or edits a migration.
- **Provider-agnostic AI.** #1255 asks the router for a capability answer; it must not name a
  provider or model anywhere in the gate.
- **`AccessContext`.** Untouched. The `surface` key in #1259 lives in persona composition, **not** on
  `AccessContext` — do not reintroduce a field there.

## Process gates

- Draft. Needs Ben's approval and the three forks resolved before dispatch.
- All six issues exist on GitHub. No new `task` issue is required.
- **Live-Path Gate binds every lane in this wave** — all six are user-visible. #1449 and #1451 in
  particular cannot merge on CI-green plus review; both are timing/caller defects that unit tests
  demonstrably did not catch.
- The `design-system` skill is mandatory before lane C's or lane D's UI work (`jds-*` audit).
