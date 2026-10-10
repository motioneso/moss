# Scheduled tasks and proactive messaging: independent spec review

## Task

Review the formal spec in `docs/superpowers/specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md` and [issue #3096](https://github.com/motioneso/moss/issues/3096). The user explicitly requested a new Herdr pane with **Opus 5.5** after spec creation. This is a review-only session; do not implement, publish build tickets, merge, or dispatch builders.

Use the requested model throughout. If Opus 5.5 is unavailable, report the limitation rather than silently switching models.

## Authoritative context

The product definition and verification boundary were approved in the preceding discussion. The user then said to create the spec. Review its fidelity rather than restarting the interview.

Read the external discussion at `~/obsidian-vault/2 Areas/Moss/Scheduled tasks and proactive messaging discussion.md`. Competitor research is at `~/obsidian-vault/2 Areas/Moss/Research/2026-10-07 Scheduled tasks and proactive messaging.md`. Keep both outside the public repo. The settled user behavior overrides research recommendations.

The user wants Matt Pocock's skills as a trial, not the usual coordination workflow. Synthesis used `to-spec`; later ticketing will use `to-tickets`. The agreed goal is complete vertical slices small enough for **one fresh session including checks, review, and demonstration**. The eight delivery areas are not final tickets and do not establish a mandatory linear chain.

## Review questions

1. Does the spec preserve every settled decision and all 13 acceptance scenarios, without silently adding approval gates or autonomous authority?
2. Are continuous main chat, invisible context handoff, side chats, and task delivery destinations precise enough to derive small tasks?
3. Can hidden provider triggers produce durable, replyable assistant messages without fabricated user turns, cross-owner access, or corrupting an active reply?
4. Are enabled-action authority, unrecoverable-deletion approval, revoked capabilities, and untrusted email/web instructions enforceable at the actual boundaries?
5. Are useful-only checks, email opt-out independence, quiet-hours work versus interruptions, and explicit user-only quiet-hours exceptions consistent?
6. Are retry safety, uncertain external effects, cancellation/edit races, watch completion evidence, expiration, and downtime behavior sufficiently specified?
7. Do testing decisions exercise observable behavior through the existing API/UI/worker seams and distinguish deterministic integration tests from real live-path evidence?
8. Are pending frontend mockups, engineering choices, and ticket review clearly marked as prerequisites rather than pretending this broad contract is build-ready?
9. What ambiguities would actually block a one-session slice? Separate those from optional enhancements or engineering choices that can be resolved in ticketing. Prefer reuse of the existing scheduler, worker, chat, and notification paths over speculative infrastructure.

## Grounding and guardrails

Read `AGENTS.md`, `CLAUDE.md`, and `docs/DEVELOPMENT_STANDARDS.md`. Prefer the codebase-memory graph for code discovery. If graph access points at another checkout, do not claim it proves your checkout; qualify the inspected baseline. The spec records inspected code at `60505036c`; compare claims to current source where it matters.

The existing briefings generation path is not the live tool-using Moss conversation pipeline. Streaming record injection is not durable delivery. Context seeding hides input but discards the reply and has a known live-turn race. Existing urgency bypass does not establish user permission for overnight proactive interruption. Avoid treating these as complete solutions without tracing their consumers.

Stay in your assigned isolated worktree, branched from the spec commit. Another session is finishing the meeting module: do not touch its worktrees, services, databases, tests, or the shared checkout at `~/Jarv1s`. Do not start a server or install dependencies for this document review. Run no DB-touching tests. Leave the review worktree clean; the report belongs outside it.

## Deliverable

Write a concise independent review to `~/obsidian-vault/2 Areas/Moss/Scheduled tasks and proactive messaging spec review - Opus 5.5.md` and post the findings as a review comment on the documentation PR for branch `research/scheduled-proactive`. Resolve that PR with `gh pr view research/scheduled-proactive --repo motioneso/moss`; it is created before this pane launches.

Lead with a verdict: ready for UI design/ticketing, or needs spec revision. Findings must give severity, the specific decision or section, why it matters, and the smallest proposed correction. If no material findings, say so explicitly. Do not approve implementation readiness while mockups and the ticket graph remain pending. Do not edit the spec or close related issue #2388. End the review when the report/comment is saved; no automatic continuation into build work.

## Start

1. Confirm Opus 5.5 is active and that this is the isolated review branch.
2. Read this handoff, the full spec, and the settled external discussion.
3. Inspect only the relevant code seams needed to ground findings.
4. Save the external review and post the PR comment. Report completion in the pane.
