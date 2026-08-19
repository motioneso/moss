# #988 Closing UX Acceptance

- **Issue:** #988, parent #983
- **Status:** Candidate for Ben approval; D1/D2 resolved; no implementation is authorized
- **Grounded on:** `origin/main` at `a0887ead` and live GitHub on 2026-07-16
- **Tier:** Routine visual polish plus manual acceptance

## Problem

The #983 UX hardening lanes have landed, but #988 still owns three things that must not be blurred
together: two unresolved polish changes, verification of behavior already on `main`, and a final
human walkthrough that turns every #983 finding into evidence or an explicit deferral.

Closing #988 from automated checks alone would miss its purpose. Conversely, treating the closing
walkthrough as permission to redesign any surface it touches would reopen settled work and bypass
the spec gate.

## Goals

- Resolve the remaining Today-label and Appearance-mode decisions before changing code.
- Verify the already-landed image-quality behavior and every closed #983 lane on current `main`.
- Run fresh first-time, deeper-News, desktop, and narrow live walkthroughs.
- Verify microphone behavior truthfully against open #900 and #901 rather than absorbing TLS or
  microphone remediation into #988.
- Attach a sanitized proof matrix, narrated summary, and release-note summary to #983.

## Non-goals

- No new acceptance harness, screenshot framework, or parallel design system.
- No iCloud delivery (#1003), News screenshot-harness expansion (#899), TLS deployment work (#901),
  or microphone error repair (#900).
- No reopening or reimplementing closed #984–#995/#1002 work without current evidence of a
  regression.
- No destructive action against a real account, credential, connector, or private data set.
- No issue closure, board move, merge, or implementation before Ben approves this candidate.

## Grounded state

Live GitHub shows #984–#987 and #989–#995 closed; #1002 is also closed. Their merged work is
acceptance input, not implementation scope. #1003 remains an honest future commitment and is not a
#983 closure blocker.

Current code already provides relevant image behavior:

- News RSS parsing prefers the widest `media:content` rendition over `media:thumbnail`; the News API
  exposes images through its authenticated, article-bound, type/size-validated image route.
- Sports feature art detects logo-sized intrinsic images and avoids enlarging them as photography.
- The focused News source/image-route suites cover host allowlisting, byte/type limits, and the
  widest-rendition choice.

Those behaviors need live visual proof and graceful-failure proof, not another image pipeline.

The closing polish was grounded as follows:

- Today renders a proactive-card priority-band badge and task due-date text in addition to existing
  order, priority stripe, and drift status.
- Appearance stores one `themes.active` value. `dark` is currently a full theme peer to Forest,
  Sage, Canyon, Teal, Dusk, and custom full-palette themes; there is no independent color-mode
  setting.

## Product decisions

### D1 — Today redundancy (approved by Ben 2026-07-16)

On Today only, remove the proactive-card priority-band badge. Keep task-row short dates, rendered in
the user's persisted timezone. Preserve priority ordering/stripe, `Overdue`/`At risk`, source,
title, and the task-detail route.

The priority-band badge is the small colored text pill rendered only on proactive cards. It prints
the internal band word `critical`, `high`, `normal`, or `low` before the card's source and summary.
It is not the priority stripe and does not control ordering. Task-row short dates such as `Jul 18`
remain visible.

The existing path already uses `useUserLocale()` and `formatDate(..., locale)`, which delegates to
the shared zoned formatter with `locale.timezone`. Implementation must preserve that path and add a
focused timezone-boundary regression check rather than introduce another formatter.

### D2 — Appearance independence (approved by Ben 2026-07-16)

Recommended minimum:

- Introduce a per-account `light | dark` color mode independent of the selected built-in accent
  theme.
- Forest, Sage, Canyon, Teal, and Dusk remain accent choices available in both modes.
- A legacy active `dark` preference normalizes to Forest + dark mode; the stored `light` id remains
  Forest for compatibility.
- Existing custom themes remain fixed full-palette themes in this slice. Selecting one explains
  that its authored paper/ink colors define its mode; the light/dark control is unavailable until a
  future dual-palette custom-theme design is approved.

Ben approved this model: the built-in theme is the independently selectable accent/color choice,
and light/dark is a separate mode toggle. The current Dark choice is Forest with dark mode enabled.
The proposed fixed-palette boundary for existing custom themes is also approved for this slice;
automatically deriving dark custom palettes or adding two editable palettes remains out of scope.

## Acceptance architecture

Use two existing mechanisms, each for its actual job:

1. `pnpm test:uat` / `tests/uat/provisioner.ts` supplies ephemeral, prod-shaped, deterministic
   accounts. Use `solo-admin` for first-time onboarding and `admin+data` or `multi-user` for the
   lived-in walkthrough and disposable destructive-flow proof.
2. Webwright supplies the one-shot browser action log and live DOM/network assertions under its local
   `final_runs/run_<id>/` contract. It drives the UAT URL and, where real configuration is required,
   the authorized deployed test instance. Nothing under `final_runs/` is committed.

The closing run uses desktop `1280x800` and narrow `390x844`. Every proof point records the build
SHA, environment kind, viewport, action/result, and evidence path. Evidence must omit passwords,
tokens, private messages, connector contents, export contents, and deletion confirmation values.

## Walkthrough contract

The fresh run covers:

- Today, Tasks, Calendar, News, Sports, Wellness, ordinary chat, private chat/history, settings
  navigation, approvals, Notes/People, Assistant/Priorities, Memory, host/account, Connected
  accounts, Modules, Skills, Appearance, and Activity.
- A separate `solo-admin` first-time owner onboarding pass, including back/forward, optional steps,
  honest unavailable states, skip consequence, and finish destination.
- A deeper News pass: sources/topics, add/edit/remove/validation, feedback, empty state, refresh,
  article links, image success, image failure, and narrow layout.
- Your data/export, deletion on a disposable UAT account only, email/calendar grant state, model
  switching, skill upload/validation/invocation, and Activity success/empty/loading/error truth.
- Microphone on a secure context when configured, plus the observed plain-HTTP LAN outcome linked
  separately to #900 (error truth) and #901 (TLS/secure context).

## Finding disposition rule

- A P0/P1 or trust/privacy regression blocks closure. Reopen the precise owner or create a scoped
  issue/spec; do not patch it opportunistically in #988.
- A confirmed D1/D2 failure is implemented only through the approved plan below.
- A lower-severity residual may be deliberately deferred only with an owner issue, reason, and
  trigger for revisiting it.
- An expected unavailable/loading state passes only when it is truthful, bounded, and offers the
  available recovery action. Endless or misleading loading is a defect.

## Exit criteria

- Ben has explicitly resolved D1 and D2.
- Any approved D1/D2 implementation and focused checks are green.
- Every #988 checkbox has a proof, deliberate deferral, or scoped implementation result.
- No unresolved #983 P0/P1 remains.
- Desktop, narrow, first-time onboarding, deeper News, and microphone checks are complete.
- #983 has the sanitized proof matrix, final narrated summary, and user-facing release note.
