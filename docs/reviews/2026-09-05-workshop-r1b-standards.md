# Workshop R1b — Standards review

Reviewed the frozen `/tmp/workshop-r1b-review.patch` (24 paths, including untracked additions)
against base `c372784983038ed3e722e7edb75cec54333efde0` in
`~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`.
Standards: `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, and `AGENTS.md`.

## Documented-standard violations

- **P1 — Check Gemini credentials after reconstructing source output.**
  `packages/chat/src/live/gemini-source-policy.ts:103–107` checks only the wire stream:
  `output.includes(secret) || output.includes(JSON.stringify(secret).slice(1, -1))`.
  Lines 144–153 subsequently join assistant contents, parse JSON, and
  `return JSON.stringify(value)` without checking that final value. Two ordinary assistant
  deltas containing `{"token":"synthetic-` and `access"}` pass the raw check but return
  `{"token":"synthetic-access"}` when that synthetic string is the credential.
  Unicode JSON escapes provide another bypass. This violates `CLAUDE.md` → Hard invariants,
  **“Secrets never escape”**: AI credentials must never reach responses or AI prompts.
  Check the final serialized object against both initial and refreshed credential secrets
  before accepting the result or enabling refresh publication; add split-delta and escaped-token
  regressions. Gemini EngineHost dispatch remains intentionally gated; this finding concerns the
  internal policy, not deployed exposure.

## Baseline smells

No additional high-confidence actionable smell findings. Shared publication and lifecycle
helpers earn their use; no speculative abstraction recommendation is needed.

## Evidence and limits

A read-only Node reproduction of the exact raw-check/join/parse operations returned
`rawGuardRejects:false` and `returnedContainsSyntheticCredential:true` using synthetic data.
Existing tests cover contiguous credential echoes but miss these reconstructions.
No broad tests, DB commands, service changes, or product edits were performed.
Assessment above describes the frozen diff.

## Follow-up disposition

**Resolved on recheck.** `gemini-source-policy.ts:152–162` now checks the final serialized
object against initial and refreshed secrets, including JSON-escaped representations, before
assigning `acceptedCredential`. The regression at `gemini-source-policy.test.ts:101–137`
covers split deltas and Unicode escapes for original/refreshed access, refresh, and quoted ID
tokens; rejection also makes refresh credentials unavailable after a previous accepted result.
Inspected `/tmp/workshop-gemini-secret-regression.log`: 11 tests across policy/store/engine
passed. Scoped lint passed per the parent agent. No remaining Standards findings.
