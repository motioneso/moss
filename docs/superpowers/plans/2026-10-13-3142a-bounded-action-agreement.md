# 3142a: bounded action agreement foundation

Parent: #3142. Build branch: `integration/scheduled-proactive`, initial pin `8c4b1aff52ee83967ab668e5d3f0a74e760e5a87`.

The user-approved stage boundary separates creation-time typed agreement and scope inspection
from unattended execution. #3142b owns effect execution, initiation recording and uncertain
outcome replay safeguards. #3142 is incomplete until that later stage and the full acceptance
proof pass. This stage does not implement background writes, deletion or action-scope editing.

## Product boundary

Use the accepted #3100 ordinary-text question and normal composer. A stated proposal names one
owned task, its exact `tasks.updateStatus` input (`taskId`, `status: done`), a one-time future
relative timing resolved to an instant, and the existing Main destination. Only a typed,
unmodified `yes` to that current question accepts it. `no`, revised or unclear replies,
replacement proposals, intervening ordinary turns and stale questions do not accept the terms.
Reload alone preserves the question and conveys no agreement.

Agreement records are separate from active tasks. There is no reminder row or queue job for them.
Settings shows accepted records under Approved changes - not active, including exact stored
scope and version. Ordinary chat explains that the agreement is saved but no change will run.
There is no Resume control or effect API for these records. Existing scheduled-read gateway
entry refuses all write operations, including this exact stored operation.

## Implementation ownership

- Chat-owned reusable proposal binder: immutable typed caller terms, owner/thread/message/version
  binding, canonical terms fingerprint, transactional consume-once acceptance.
- Bounded creation adapter: configured JSON model for candidate/time interpretation, server-owned
  operation/status, owner rechecks and ordinary-chat refusal/save paths.
- Chat migration `0322_chat_responsibility_agreements.sql`, database types and manifest ownership.
- Separate approved-scope response contract and existing Settings primitives, without new cards,
  approval buttons or task editing forms.
- Existing freshness helpers are extracted intact to keep persistence under its 1000-line cap.

The binder stores caller-validated terms without owning action semantics. #3141 suggestions and
#3144 scoped edits can reuse its proposal identity/version/fingerprint and consume-once contract;
those adapters are not implemented here. Existing live-chat outside-content rules are unchanged.
No model/source text can call the binder's acceptance directly through an assistant tool.

## Verification plan

Pure behavioral tests cover exact terms, malformed/widened input, typed agreement versus revised
text, decline, cancellation, stale proposal/version/fingerprint, replay and real gateway refusal.
Database integration tests cover owner versus foreign owner/admin, source/message provenance,
immutable fields, duplicate acceptance, accepted Settings records and absence of reminder/jobs.
The required isolated database workflow is `scripts/run-gate.sh`; never a direct DB suite.

Observe key scope/freshness/source and gateway assertions fail with their enforcement removed.
Retain bounded verdicts rather than private values. Run scoped lint, root and test TypeScript,
formatting, file-size and UI audits, then the final-head full foundation gate. Independent review
and installed real UI proof remain required before merge.

Installed proof must exercise ordinary chat proposal, decline/revision, reload, current typed
agreement, Settings exact inert scope and no Resume, plus real gateway write refusal and unchanged
disposable task after the agreed time. Use executable DOM/network/database assertions and bounded
textual evidence, with no screenshots or rewritten API/Moss responses. A configured model remains
provider-agnostic; any third-party stand-in is disclosed. If an isolated installed instance or DB
gate is unavailable, report code-complete, unverified and leave merge blocked.
