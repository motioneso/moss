# Handoff: adversarial Job Search UI review

**Scope:** research and critique only. Do not modify production code, user data, module state, or
shared dev processes.

## Goal

Produce a candid, evidence-backed design review of the live Job Search module and its surrounding
Jarv1s shell. Be unusually critical: find the things a polite design review would miss, rank them by
user harm, and distinguish taste from observable usability problems.

The live dev UI is `http://100.64.98.99:5197`. Dev credentials are available to your process as
`JARVIS_DEV_EMAIL` and `JARVIS_DEV_PASSWORD`; never print, log, screenshot, or commit them. The
instance currently serves issue #1246 from the `perms-1246` worktree. Navigate read-only: do not send
chat messages, change settings, start searches, dismiss matches, upload files, or otherwise mutate
Ben's data.

## Required research

Use live web search and high-trust primary sources. Cite the exact page supporting each claim.

1. **Competitive products.** Study current first-party product pages, help centers, or demos for
   serious job-search workflows such as Teal, Huntr, Simplify, LinkedIn, and any
   stronger direct comparator you discover. Compare information architecture, job triage, profile
   setup, progress communication, search controls, density, and the handoff between AI assistance and
   direct manipulation. Do not turn this into a feature checklist; identify patterns that make the
   core work faster or clearer.
2. **Recognizable AI-generated design.** Research credible descriptions and concrete examples of
   visual and interaction patterns that make software feel machine-generated, generic, or
   over-produced. Use the `hallmark audit` skill as one lens, but corroborate its advice with external
   primary or authoritative sources. Look beyond purple gradients: repeated card grids, excessive
   pills and rounding, decorative sparkles, chatbot-first interaction where direct controls would be
   clearer, vague synthetic copy, uniform spacing/rhythm, fake metrics, glass effects, gratuitous
   motion, weak hierarchy, and template-like page structure are hypotheses to test—not conclusions to
   assume.
3. **General design practice.** Ground the review in established usability, accessibility, and
   interaction guidance: Nielsen Norman Group heuristics or original Nielsen material, WCAG/WAI,
   platform design systems, and other first-party research appropriate to the observed problems.
   Include keyboard/focus, contrast, responsive behavior, error/status visibility, cognitive load,
   progressive disclosure, affordance, and empty/loading states where relevant.

## Audit method

- Read `AGENTS.md`, `CLAUDE.md`, and `docs/DEVELOPMENT_STANDARDS.md` first.
- Use the `research` skill for source discipline and `hallmark audit` for the anti-AI-slop pass.
- Inspect the live UI at desktop and at least 375 px mobile width. Record DOM, computed-style, and
  layout assertions as evidence.
- Review at minimum: shell/navigation, Job Search Matches, Overview, Profile, Monitors, one match
  inspector if opening it is read-only, and the chat drawer without sending a message.
- Inspect the authored tokens and relevant Job Search web source only after forming a live-UI
  impression. Use the repository's codebase graph tools before architectural claims.
- Separate findings into:
  - usability/accessibility defects;
  - visual hierarchy and craft problems;
  - AI-design tells and generic patterns;
  - competitive gaps worth copying in principle;
  - things Jarv1s does better and should preserve.
- For every finding include: evidence, why it matters, severity, and the smallest credible remedy.
  Avoid redesign theater and speculative feature work.
- End with a prioritized `Fix now / Fix next / Do not chase` list. Be explicit about anything that
  is merely taste.

## Deliverable

Write one report at:

`docs/superpowers/research/2026-07-30-job-search-ui-critical-review.md`

Store bounded assertion output under a gitignored scratch directory and link it by a portable
repo-relative description in the report. Commit only the report and any directly required research
metadata to your branch.

When finished, send a concise completion message to the Codex pane labeled `perms-1246`, including
the report path, commit SHA, and your five highest-severity findings. Do not push, open a PR, or edit
GitHub.

## Start

1. Run `pnpm install`.
2. Read the three governing repo documents and both named skills in full.
3. Verify the live UI is reachable and that the credential environment variables are present without
   printing their values.
4. Create a short audit plan, then begin the competitive research and live inspection.
