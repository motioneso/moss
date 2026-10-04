# Meeting output and review slice

Builds the approved meeting companion specification, sections 7–9, under issue #2981 and draft PR #2982.

## Bounded implementation

1. Add owner-only, immutable generated/manual artifact snapshots and mutation receipts in migration 0265. Preserve input transcript and personal-note revisions, exact UTF-16 evidence ranges, template version, safe executed model identity, and stale status.
2. Reserve each generation request before provider dispatch. Replay never dispatches again. Provider work runs outside database transactions with a two-minute deadline. Abandoned reservations reconcile to a terminal interrupted result; late completion checks the locked receipt before writing.
3. Resolve live summarization routing and credentials in the composition-root adapter for each attempt. Honor hard admin pins, then the Meetings binding, then the worker binding; unavailable fixed bindings fail closed. Reject tool-capable CLI transports, do not invent provider fallback, and use one provider attempt. The output service validates every decision/action anchor against its pinned bounded inputs. Structural validation does not prove semantic support; owner review remains necessary.
4. Keep generated actions as candidates. Exact proposal/evidence equality reuses identity; nonexact proposals are flagged for review. Acceptance uses the Tasks public create API inside the same owner transaction and candidate lock. A stable meeting/candidate external key deduplicates acceptance. Never update accepted Tasks during replay or regeneration. Dates are owner-selected; preserve spoken relative-date phrases without conversion.
5. Expose owner-authenticated generation, immutable history, version-checked manual edits, and candidate review routes. Update module manifest and app-map behavior together. Private vault exports use the separately owned 0266 slice and Notes public interface.

## Verification

Pure tests cover evidence bounds and binding, template versions, safe errors, generation replay, stale completion, interrupted reservations, and owner authorization failure. Integration tests cover owner/admin isolation, concurrent acceptance, preserved Task edits, stable decisions across regeneration, and independent Task deletion lifecycle.

Run database suites only through the repository verify-gate workflow. Local Docker is unavailable in this environment, so database execution and full CI remain pending. No real provider credentials, audio, or workplace recordings are used for tests. Passing unit/static checks does not replace real-UI proof or authorize merge.

## Output delivery and review

- The existing meeting Review surface shows real generated/manual versions, exact evidence, and pending/accepted/dismissed action candidates. Older candidate evidence is fetched through an owner-scoped exact-version route when outside the latest history window.
- Owner approval creates a Task once; later regeneration or retries cannot rewrite it. Relative date phrases remain evidence, not inferred deadlines.
- Notes exports are explicit immutable versioned copies in the Moss private vault. A repeat inspects the existing hash and never overwrites manual edits. A new artifact version requires a new copy. Linked or shared vaults and in-place updates are deferred.
- Vault write and indexing acknowledgement are separate receipts. Queued or delayed is not Indexed. No supported note-opening URL is invented.
- Summarization uses the configured API-key model with summarization and JSON capabilities. CLI transports and oversized inputs return explicit capability/input errors; no model substitution or full-length meeting claim.

## Checkpoint scope

The preceding transcript/chat checkpoint is commit `bb7181d`, with normal CI and real UI acceptance green. This output slice is a separate staged checkpoint. Its real-path acceptance test uses disclosed local HTTP model stand-ins, never private provider credentials or user audio. It exercises generation, exact citations, reviewed Task creation, preservation of Task edits, manual output revisions, private copies, receipt replay, and independent copies after meeting deletion. This is not actual provider compatibility or native capture proof.

Database gate isolation must follow issue #2989: every gate needs its own disposable Postgres server, not merely a separate database on a shared server. GitHub-hosted jobs use disposable isolated runners; local users must wait for the supported per-server gate implementation before invoking DB-backed commands on a development machine.
