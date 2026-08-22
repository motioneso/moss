# Plan — #1517 (spec 1137-C4): Escape commitment evidence excerpts as plain text

**Spec:** `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` section `### C4 — Plain-text evidence excerpts`
**Issue:** #1517
**Risk tier:** routine

## Seams check (file:line)

- `sanitizeExcerpt` is a private (unexported) function, only caller is `CommitmentsRepository`:
  `packages/commitments/src/repository.ts:210-212` — current body:
  `text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").slice(0, 500)`.
- Both call sites pass through it: `packages/commitments/src/repository.ts:71` (insert) and `:77`
  (upsert conflict update).
- Read path for tests: `getEvidenceForCandidate` at `packages/commitments/src/repository.ts:155-167`,
  returns `CommitmentCandidateSource[]` via `rowToSource`, field `evidenceExcerpt` mapped at
  `packages/commitments/src/repository.ts:257`.
- DB constraint confirms the 500-char ceiling is a real, already-applied limit, not new:
  `packages/commitments/sql/0125_commitment_candidates.sql:75` —
  `evidence_excerpt TEXT NOT NULL CHECK (char_length(evidence_excerpt) <= 500)`.
- Existing integration coverage for this repository: `tests/integration/commitments.test.ts`,
  `describe("addEvidenceRow", ...)` at line 146 — no existing case exercises excerpt content,
  only row-count enforcement.
- No migration needed (spec: "This spec requires no new migration") — confirmed, this is a
  pure TypeScript change to `sanitizeExcerpt`.

## Task 1 — Replace regex strip with character escaping, truncate to 500

**File:** `packages/commitments/src/repository.ts`

Replace the body of `sanitizeExcerpt` (lines 210-212) with a single pass that escapes `&`, `<`,
`>` (in that order, so `&` from `<` -> `&lt;` isn't double-escaped) and truncates the escaped
result to 500 characters. No new dependency; no HTML sanitizer library.

Signature is unchanged: `function sanitizeExcerpt(text: string): string`.

Order of operations: escape first, then truncate the escaped string to 500 chars (spec: "then
truncates the stored result to 500 characters so the existing database constraint still holds" —
truncation applies to the escaped output, matching the DB check on the stored value).

## Task 2 — Integration test cases (`tests/integration/commitments.test.ts`)

Add a new `describe("addEvidenceRow — excerpt escaping", ...)` block (or extend the existing
`addEvidenceRow` describe) using the existing `repo.addEvidenceRow` + `repo.getEvidenceForCandidate`
round trip (create a candidate, add one evidence row, read it back, assert on
`evidenceExcerpt`). Test cases, stated as behaviour + why each would fail against the current
regex-strip implementation:

1. **Ampersand escaped** — input `"Ben & Jarv1s"` stored/read back as `"Ben &amp; Jarv1s"`.
   Fails today because `&` passes through unchanged (only `<script>` is touched).
2. **Angle brackets escaped, non-script tag preserved as text** — input
   `"<b>bold</b> plan"` stored/read back as `"&lt;b&gt;bold&lt;/b&gt; plan"`. Fails today because
   the regex only strips `<script>...</script>`; a `<b>` tag passes through raw.
3. **Script-like input neutralized without special-casing `<script>`** — input
   `"<script>alert(1)</script> ok"` stored/read back as
   `"&lt;script&gt;alert(1)&lt;/script&gt; ok"` (i.e. escaped, not stripped-to-empty). Fails
   today because current code strips the whole script block instead of escaping it, so the
   before/after text differs from what C4 requires (escape, don't strip).
4. **Ordinary text, whitespace, quotes, non-ASCII unchanged** — input
   `` `Réunion at 3pm — "quarterly" review\n\ttab` `` stored/read back byte-identical. Guards
   against over-escaping (e.g. quotes) regressing this case.
5. **Final length at most 500 after escaping expands the string** — input is 500 raw `&`
   characters (`"&".repeat(500)`); after escaping each becomes `&amp;` (2500 chars), assert the
   stored/read-back value has `length <= 500` and is a prefix of the fully-escaped string (i.e.
   truncation happens post-escape, not pre-escape leaving raw `&` at the cut point). Fails today
   because current code truncates raw input to 500 first, so a full escape pass afterward would
   overflow the DB constraint — this test would catch a wrong task-1 ordering, not just the
   missing escaping.

## Verification

```bash
pnpm --filter @moss/commitments typecheck > /tmp/1517-typecheck.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Integration test run uses the guarded gate DB procedure (per `verify-gate` skill) — not run ad
hoc against the shared dev DB:

```bash
# via verify-gate skill's isolated gate DB, focused to this file
pnpm vitest run tests/integration/commitments.test.ts > /tmp/1517-commitments-test.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, all `CommitmentsRepository` cases pass including the 5 new excerpt cases.

```bash
pnpm check:file-size > /tmp/1517-filesize.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Final full gate at wrap-up: `pnpm verify:foundation` on an isolated gate DB per `coordinated-wrap-up`.

## Kill gate

Single-task lane; no phase 2. If the escape+truncate ordering test (case 5) reveals the DB
constraint would still be violated by any construction, stop and escalate to the coordinator
before merging — do not weaken the DB check or silently change truncation semantics beyond what
the spec states.

## Live-path

Per spec's Acceptance table for C4: "Use only synthetic evidence. Confirm the real commitment
read/tool path returns the stored plain-text-safe excerpt without rendering active markup." This
is backend text-handling with no rendered UI surface in this change; per handoff, confirm with
coordinator whether the live-path proof is required or whether "code-complete, unverified" plus
the synthetic integration tests satisfies C4's own acceptance line before wrap-up.

## Non-goals (per spec)

No HTML sanitizer library, no commitment UI, no repository abstraction, no broader commitments
refactor.
