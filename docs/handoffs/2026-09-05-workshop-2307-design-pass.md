# Handoff: Workshop PR 2307 — click-through done, design pass still to do

2026-09-05. Plain English, no jargon, in every message and every prompt you write for another
agent. Pass this rule on.

## What Ben tested and what he said

Instance http://192.168.50.36:20001, login `uat-admin@jarv1s.local` / `uat-admin-password-1025`.
Branch `feat/workshop-projects-phase-a`, worktree `~/Jarv1s/.claude/worktrees/workshop-pr`, PR 2307.

Working: making a project from the screen, coming back to it later, adding a second message,
the honest "building is switched off" message, and the full-width layout.

Not tested yet: starting a project by asking the assistant in the chat drawer. That is the one
remaining piece of live proof PR 2307 needs.

His verdict on the look: "bland and boring... and unfinished. Like margins and such."

## The next job

A design pass on the Workshop screens, agreed with Ben before it is built.

Workshop skipped the step the standards require: a front-end design discussion and agreed mockups
of every screen before implementation (`docs/DEVELOPMENT_STANDARDS.md`, Design System Guardrails).
That is why it looks unfinished. Do not go straight to CSS. Use the `design-system` skill first,
show Ben mockups of each Workshop screen, get his ruling, then build.

Two standing rules he has already given, both in memory: use the horizontal space (no big side
gutters with content crammed narrow), and the design system is authored, not generated - only real
`jds-*` primitives, never invented class names.

## State of the code

- Branch has main merged in and is pushed. Gate was green before the merge; rerun it after any
  new work.
- Still to delete before PR 2307 merges: `tests/uat/hold-instance.ts` (untracked, temporary). It
  is what keeps the test instance alive, so delete it last.
- Release note section of PR 2307 is filled in.

## The chat fix that unblocked this

Issue 2317, PR 2318, merged today. Chat could talk but could not use any tool on the current
Claude command-line program, because the launcher passed a tool-narrowing flag that on version
2.1.183 also drops all 101 Moss tools. Both launchers now leave the flag off when the tool server
is configured. Proved live on this instance: chat called the app-map tool and listed the Settings
screens back.

Follow-up left open: issue 2320. With the flag gone, chat can see the command-line program's own
tools again (Bash and so on). They are all refused if it tries them, so nothing is exposed, but it
may mention a tool it cannot use. Worth trying the deny-list flag instead, and proving it against
a live instance, not a unit test.

## The test instance

Compose project `uat-2310192_431cbf16`, container `moss`, published on port 20001. Nothing is
holding it open any more, so it stays up until someone removes it:
`docker compose -p uat-2310192_431cbf16 down -v`.

To rebuild one: run `npx tsx tests/uat/hold-instance.ts` from the worktree, then install the
Claude program into it and sign it in through the API - `POST /api/onboarding/provider-install`
with `{"providerKind":"anthropic"}`, then `POST /api/onboarding/provider-login/begin` with the
same body. The first begin call is what registers the model; a later poll call returns a 500
because the sign-in is already finished, which is harmless.

## Traps this session hit

- **A new test instance on a port an old one used will hang on the loading screen.** Ben's browser
  kept serving the previous build from a saved copy on the same address. A hard reload fixed it;
  clearing the site's stored data or a private window also works. Nothing was wrong with the
  server - every request it received answered 200.
- Run the gate only through `scripts/run-gate.sh`, never piped, and read the exit code.
- A fresh worktree needs `pnpm install` before tests will run at all.
