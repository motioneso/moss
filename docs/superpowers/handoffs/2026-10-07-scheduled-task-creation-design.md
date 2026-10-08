# Scheduled tasks: creation design session

## Goal and authorization

Deliver the first remaining clickable design preview: creating scheduled tasks in chat, including Moss suggestions and one-time approval for actions that change or delete data. Ben approved four separate design sessions on 2026-10-07 and requested a fresh session with a brief. Complete only this first design flow and leave it ready for his review.

This is throwaway mockup work. Production implementation, backend work, scheduling/provider changes, a build fleet, and progression through all four sessions are not authorized. Keep all chat, status, and handoff notes in plain English for Ben.

## Sources

- This session owns [design task #3100](https://github.com/motioneso/moss/issues/3100). Later design tasks are [#3101 Settings](https://github.com/motioneso/moss/issues/3101), [#3102 updates](https://github.com/motioneso/moss/issues/3102), and [#3103 preferences](https://github.com/motioneso/moss/issues/3103). Only #3101 is blocked by #3100.
- Product spec: [issue #3096](https://github.com/motioneso/moss/issues/3096), [draft PR #3097](https://github.com/motioneso/moss/pull/3097).
- Authoritative spec revision: `13cd364fe`, on `research/scheduled-proactive`. Read `docs/superpowers/specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md` from that revision with git show; it may not be in this preview branch. Do not switch branches or modify the spec worktree.
- Discussion and review: `~/obsidian-vault/2 Areas/Moss/Scheduled tasks and proactive messaging discussion.md` and `Scheduled tasks and proactive messaging spec review - Opus 5.5.md` in the same folder.
- Individual session briefs, tracker links, and live state: `~/obsidian-vault/2 Areas/Moss/Design previews/Scheduled proactive design sessions/`.
- Accepted chat navigation primary source: branch `prototype/main-side-chat-navigation`, decision commit `d5d0708dc`, and `apps/web/src/chat/main-side-chats.prototype.md`.

## Accepted chat design

- Keep the existing default chat width. The prototype's docked mode is 380px; the real floating drawer is 404px. Do not widen either to accommodate navigation.
- A three-line menu, closed by default, opens the conversation list over the chat without moving messages or composer.
- New side chat is inside that menu, not in the chat header. No main-chat update banner is ever displayed in a side chat.
- New side chat opens directly to an empty conversation and composer. Moss generates its title from the conversation. The inherited prototype still has an old title dialog; Ben explicitly waived another mockup for this change. The accepted decision overrides that old code. Do not spend this session rebuilding side-chat behavior.
- Open the email links to the connected provider's webmail in a separate tab. Gmail is one example, not a hardcoded product requirement; no email popup inside Moss.
- Main chat is continuous; side chats organize topics with separate transcripts and shared owner memory/preferences. Task results go to main chat unless the user explicitly chooses a side-chat destination.

## First session scope

Use Matt Pocock's prototype skill for UI exploration, read its UI branch, and reuse Moss's authored design system and existing UI primitives. Build this flow next to chat, with a clearly named throwaway preview entry. Compare structurally different presentations of task creation on a single route. Preserve the accepted surrounding navigation rather than offering more navigation options.

Show these paths with fictional content and browser-only state:

1. A sufficiently specific user request for a reminder saves directly and confirms the instruction and local timing. A read-and-report watch also saves directly. No second generic approval step.
2. Moss suggests a three-hour inbox watch. It remains a proposal until the user agrees; show agreement and decline behavior.
3. A task that will change or delete data has one creation-time confirmation listing those actions, deletion included. Saving approves those actions; declining leaves it unsaved.
4. The saved outcome shows the relevant instruction, time/cadence, duration/deadline, destination, and approved actions. Keep fields relevant to the selected example instead of presenting a workflow builder.

Background tasks never ask again. Their runs refuse actions outside the approved set rather than asking; revoked or disabled capabilities still prevail. Editing the actions needs approval of the new set. Editing only timing or destination does not. The live-chat outside-content rule remains unchanged. Do not add a runtime approval inbox or a hidden new approval gate.

Use ordinary language, and keep provider mechanics, background triggers, compaction, queues, and other implementation details out of the product UI. Saved state in the prototype is a demonstration, not proof of real task persistence or permissions.

## Boundaries

- Work only in your new isolated worktree and branch. You are not alone in the repo; do not revert others' changes or touch the shared checkout, meeting work, other services, or any database.
- Leave the navigation preview and its running server alone. It uses reserved port 5182 for Ben's ongoing reference.
- Claim your own preview port with `devports claim scheduled-create-design`, from the shared 5180–5299 range. Never pick a port manually or use 5173 or 1533. Publish private preview addresses only in the vault and to Ben, never in GitHub or committed documents.
- Keep research, screenshots, logs, and private live state outside the repo. Use `~/Jarv1s` style paths in public documents, with no usernames, private hosts, or local network addresses.
- No real auth, source fetching, provider calls, API mutations, background workers, or persistence. No database tests or foundation gate.
- Prefer the codebase graph for discovery; narrow text searches may cover literals and unindexed preview files. Read only bounded relevant passages. Never inspect a full-page screenshot; crop first.
- Use the simplest existing rendering and controls. No new library, framework, or abstraction to support this mockup.
- Use scoped formatting/lint/type checks and the existing design-token and UI-class checks as applicable. Verify the important clickable flows in a browser at desktop and phone sizes. No production test suite is needed for a throwaway mockup.
- Commit only session-owned paths and push the throwaway branch. Keep it out of main. Existing app-map metadata must not claim the mockup is a shipped product capability.

## Deliverable and stopping point

Provide a shareable preview, compact desktop/phone browser evidence, and honest check results. Save a short status note in the vault with branch, commit, preview command and reserved port, what was agreed, and anything unresolved. Post the public branch and check evidence on your design ticket without private preview addresses. Leave the design issue open while awaiting Ben's review.

Do not move into Settings, update-state, preference mockups, or production implementation. Session 2 is task management; session 3 is proactive update states; session 4 is email and quiet-hours preferences. Only task management depends on the creation flow's accepted fields; the other review ordering is not a false dependency. A later session will update the spec and propose implementation tickets for Ben to review.

## Start

1. Read your local AGENTS.md and CLAUDE.md, then this handoff and the first individual design brief in full. Search Hindsight for relevant prior decisions, but verify against the authoritative spec and these recent decisions; its initiative page previously overstated design completion and ticket approval.
2. Read the latest creation/approval contract from spec revision `13cd364fe` and the accepted preview notes. Use Matt Pocock's prototype workflow, not coordinate, start, coordinated-build, or a fleet. Do not restart the product interview.
3. Install dependencies in this fresh worktree using the repository's normal pnpm command. Claim a separate preview port, write a small external live-state note, then build and verify only this creation flow.
4. Share the preview with Ben and stop for his review. Keep every message in plain English. Do not request permission for already authorized reversible mockup work.
