# Workshop offline checkpoint

Worktree: `~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`.
Work remains uncommitted. This is an implementation/verification checkpoint, not release acceptance.

## Standards

One P1 finding was fixed and independently rechecked: Gemini source credentials reconstructed
from assistant deltas or Unicode escapes could evade the raw-stream guard. The final normalized
JSON is now checked before source acceptance and refreshed-credential publication. Eleven focused
tests pass; no remaining actionable Standards findings. See
[the report](2026-09-05-workshop-r1b-standards.md).

## Spec

No concrete defects or scope creep found in the bounded candidate. Full R1b acceptance remains
incomplete: Gemini vendor/browser login and deployed actor-scoped RPC remain unverified; tested
Codex policies remain unsuitable. Keep both source-dispatch gates. See
[the report](2026-09-05-workshop-r1b-spec.md).

Findings: Standards 1 resolved, 0 remaining; Spec 0 defects, with acceptance gaps retained.

## Verification and remaining scope

Four pinned installed Gemini engine cases and nine existing OAuth controls pass. Six Settings
tests pass after correcting the Workshop provider fixture. Repository lint and root TypeScript
pass. The full isolated foundation gate is **red** at formatting in unchanged baseline files;
separate test TypeScript/file-size checks also identify unchanged baseline failures. It is not
valid to claim full-suite or CI success. Exact evidence and cleanup are in
[the live state](../handoffs/workshop-live-state.md).

The authorized offline capability work has local implementation and bounded evidence. Next product
milestones require the retained vendor/deployment/runtime acceptance and R1e/durable-authority gates.
Additional repetition of the same synthetic proofs would not close those gaps. Existing task #2277
remains open/In progress; no release, merge, host installation or execution enablement occurred.
