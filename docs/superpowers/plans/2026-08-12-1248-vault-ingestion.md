# Build plan: #1248 internal-vault ingestion

**Spec (approved by Ben 2026-08-12):** `docs/superpowers/specs/2026-08-12-1248-internal-vault-ingestion.md`
**Task issue:** #1248 (`task` label). **Grounded on:** `origin/main` = `2852a12c3`.
**Plan author:** Fable (spec-1248 session), per the plan-authorship rule.

## Seams check (all cited from the current tree)

| Capability the plan assumes | Evidence |
| --- | --- |
| Vault→index ingester exists, `.md`-only, per-file txn, purge on full run | `packages/memory/src/ingestion-service.ts:26-70` |
| Pipeline hash-skips, owner-stamps from `vaultCtx.actorUserId`, writes `source_kind='vault'` | `packages/memory/src/ingest.ts:12,40-87` |
| `memory_chunks`/`memory_file_index` RLS owner-only; worker policies; CHECK already allows `'vault'` | `packages/memory/sql/0030_memory_index.sql:44-47`, `0054_worker_memory_rls.sql`, `0106_memory_notes_source_kind.sql:8` |
| `notes.search` retrieves notes-kind only via `MemoryRetriever` | `packages/notes/src/tools.ts:51` |
| Briefings compose already queries vault chunks (capped); deps report `getLatestIngestedAt(scopedDb,"vault")` | `packages/briefings/src/compose.ts:203-205`; `packages/module-registry/src/index.ts:1500-1508` |
| Action-row relevance already queries vault chunks | `packages/module-registry/src/index.ts:1057` |
| pg-boss worker pattern deriving RLS principal from `job.data.actorUserId` | `packages/jobs/src/pg-boss.ts:340`; example `packages/chat/src/jobs.ts:315` |
| Scheduled-sweep precedent (15-min notes-sync, stale-tick guards) | `packages/notes/src/jobs.ts:33-49,435-458` |
| Per-actor vault access via `vaultRunner.withVaultContext(ac, cb)` | `packages/vault/src/vault-context.ts:34`; usage `packages/people/src/routes.ts:193` |
| Per-user vault directory layout (owner enumeration is directory enumeration) | `packages/vault/src/vault-ops.ts:205` (`deleteUserVaultDir(vaultsBaseDir, userId)`) |
| Live writer: people-notes at `<folder>/<slug>.md`; folder is a per-user preference | `packages/people/src/notes-service.ts:411-421,228,264` |
| Dormant writer: structured-state write-back to `entity.vault_note_path`; nothing sets it in prod | `packages/structured-state/src/write-back.ts:33-44`; only reader `packages/settings/src/data-export-queries.ts:610` |

**Open questions (owner: build agent, resolve in Task 1 before coding onward):**

1. Where memory's job workers get wired a `vaultRunner` — follow the chat jobs wiring
   (`packages/chat/src/jobs.ts`) and cite the actual injection point in the PR description.
2. pg-boss singleton dedupe buckets on a fixed epoch grid (memory `#1547`) — do **not** rely on
   singleton dedupe for nudge correctness; duplicate nudges must be harmless (they are: hash-skip).

## Determinism boundary

No new model jobs. The model's only contact with this feature is reading blended `notes.search`
results (and, in Phase 3, port-blended snippets) — context, not instructions, through the existing
#1553 fencing. No model-authored values cross into user data; the four-guard rule is not invoked.
All surfaced provenance (source label, path, modified time) renders from the chunk/file-index
records. The only prompt-adjacent change is the `notes.search` tool description update: **≤ 60
words**, stating it also covers Moss-written internal notes.

## Phase 1 — ingestion registry + sweep + nudge (no surfacing)

**Task 1: allowlist registry.** New `packages/memory/src/vault-ingest-registry.ts`:

```ts
export interface VaultIngestRootProvider {
  readonly moduleId: string;
  /** Owner's ingestable vault-relative root prefixes; empty = nothing for this owner. */
  resolveRoots(scopedDb: DataContextDb, ownerUserId: string): Promise<readonly string[]>;
}
export function registerVaultIngestRootProvider(p: VaultIngestRootProvider): void;
export function listVaultIngestRootProviders(): readonly VaultIngestRootProvider[];
/** True only for `.md` under a resolved root and not under a hard-excluded prefix. */
export function isPathIngestable(relPath: string, roots: readonly string[]): boolean;
export const HARD_EXCLUDED_PREFIXES: readonly string[]; // ["attachments/", "exports/"]
```

Resolved roots under a hard-excluded prefix throw at resolve time (spec's belt-and-braces rule).

Tests (behaviour + why they fail against a broken implementation):
- unregistered path never ingestable — catches a default-open predicate;
- `attachments/x.md`, `exports/x.md` not ingestable even if a provider resolves them, and the
  resolve-time throw fires — catches allowlist-only enforcement without the hard guard;
- non-`.md` under a valid root not ingestable — catches extension-filter regression.

**Task 2: sweep + nudge jobs.** New `packages/memory/src/vault-ingest-jobs.ts`:

```ts
export const VAULT_INGEST_SWEEP_QUEUE = "memory.vault-ingest-sweep";   // payload: { actorUserId }
export const VAULT_INGEST_NUDGE_QUEUE = "memory.vault-ingest-nudge";
export interface VaultIngestNudgePayload {
  readonly actorUserId: string;
  readonly sourcePath: string;          // vault-relative; metadata only, never content
  readonly op: "upsert" | "delete";
}
export function registerVaultIngestWorkers(boss: PgBoss, deps: VaultIngestWorkerDeps): Promise<void>;
/** Public API writers call after a successful allowlisted write/delete. Best-effort. */
export function scheduleVaultIngestNudge(boss: PgBoss, payload: VaultIngestNudgePayload): Promise<void>;
```

- Scheduler tick (15-min default, env-overridable) enumerates owner dirs under the vaults base
  and enqueues one sweep job per owner (`actorUserId` payload — fits
  `registerDataContextWorker`'s RLS derivation, `pg-boss.ts:340`).
- Sweep = allowlist-filtered `ingestVault` semantics: per-file txns kept, then purge limited to
  allowlisted roots (a file that leaves the allowlist is purged like a deleted file).
- Nudge = single-file ingest/delete; failure logs and defers to the sweep.
- Writers wired in this phase: people-notes registers its provider (folder preference) and calls
  `scheduleVaultIngestNudge` after its `writeVaultFile` sites (`notes-service.ts:228,264`) and its
  delete path; structured-state registers its provider (entity `vault_note_path` values) but has
  no live producer — registration only.

Tests:
- allowlisted write → sweep produces `source_kind='vault'` chunks with the right owner — catches
  wiring that never reaches the pipeline;
- second sweep on unchanged vault ingests 0 (hash-skip observed in stats) — catches force-reingest;
- delete then sweep → chunks + file-index row gone — catches missing purge scope;
- one file throwing embeds fails only that file; failure present in stats — catches shared-txn
  regression;
- cross-owner: owner B's sweep never touches owner A's rows (RLS-level assertion) — catches
  actor-context leaks;
- nudged write retrievable without any sweep run (freshness bound) — catches nudge-as-no-op.

**Phase-1 e2e (executed and observed):** integration test against a real gate DB — create a
people-note through `PeopleNotesService`, run the sweep worker, assert chunks retrievable via
`MemoryRetriever.retrieve(..., "vault")`, then delete and assert purge. Grep proof that production
wiring registers the workers (the `wired-not-just-defined` check): cite the registration call site
in the PR.

**KILL GATE (owner: Ben, on Coordinator's evidence).** After Phase 1 ships and runs on the dev
instance for a day: if per-owner sweep cost, index growth, or chunk quality on real people-notes
looks wrong (e.g. frontmatter/managed-section noise dominating chunks), stop the line here —
Phase 1 alone is inert (nothing user-facing reads vault chunks except briefings/action-row, both
already capped). Phase 2 is not planned in finer detail until this call is made.

## Phase 2 — `notes.search` blend + live-path proof

**Task 3:** `packages/notes/src/tools.ts` — query both kinds, merge by score. Result rows gain:

```ts
{ source: "notes" | "vault"; sourcePath: string; modifiedAt: string | null; /* existing fields */ }
```

`modifiedAt` comes from the file index; tool description updated (≤ 60 words). The result-shape
change is additive (memory: `manifest-routes-are-public-api` — additive only, no field renames).

Tests:
- blended result set correctly labeled per kind, score-ordered — catches single-kind regression
  and mislabeling;
- owner isolation through the tool (user B never sees A's vault chunks) — catches retriever
  bypassing the actor context;
- vault-kind results carry path + `modifiedAt` — catches provenance dropped at the tool boundary.

**Phase-2 e2e (the spec's live-path gate, recorded on the PR):** on the live dev instance — tell
Moss a fact about a person so it writes/updates a people-note; in a fresh session ask a question
answerable only from that note without naming it; the answer uses the note and can cite it.
Verify a **real assistant reply record** exists, not just HTTP 200 (memory:
`chat-turn-latency-182s` — a watchdog trip returns 200 with an empty reply). Also record the
briefings consumer proof (spec AC 5) from this instance.

## Phase 3 — #1553 notes-recall port blend (**BUILD-TIME SEQUENCING CONSTRAINT**)

**Blocked until #1556's retrieval phase is merged to `main`. Do not touch the port while #1556 is
mid-build.** Then: the port implementation adds the vault kind to its query; the port *contract*
(path, modified time, score, sanitized snippet) is unchanged, and the existing #1553 gates
(incognito, `recallEnabled`, credential screen, fencing) must pass their existing tests unchanged
with vault chunks flowing through. New test: vault-kind snippet passes the credential screen and
fencing identically to a notes-kind snippet — catches a second, weaker injection path.

## Verification (every phase; never piped — expected `EXIT=0`)

Use the `verify-gate` skill (isolated gate DB; memory: `createapiserver-default-boss-uses-env-db`).

```bash
pnpm verify:foundation > /tmp/vf-1248.log 2>&1; echo "EXIT=$?"
```

## Rulings ledger

- Ben 2026-08-12: surfacing blends into notes surfaces (option A) — no separate search tool.
- Ben 2026-08-12: spec approved as written; fail-closed allowlist affirmed.
- Fact: only live internal-vault `.md` writer is people-notes; structured-state dormant
  (`vaultNotePath` has no producer — grep 2026-08-12, only `data-export-queries.ts:610` reads it).
- Fact: briefings + action-row relevance have queried an empty `'vault'` index since shipping
  (citations in seams table) — lighting them up is deliberate, bounded by their existing caps.
