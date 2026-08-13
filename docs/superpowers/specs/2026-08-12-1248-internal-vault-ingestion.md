# Internal-vault ingestion: first-party vault notes become searchable

**Date:** 2026-08-12

**Status:** Draft — pending Ben sign-off

**Parent issue:** #1248 (vault-ingestion half). The passive-retrieval half of #1248 was split off
2026-08-10 and is owned by the approved #1553 spec
(`2026-08-10-1553-context-continuity-and-notes-retrieval.md`, build task #1556); this spec must
not re-open it. Related but separate: #1368 (transcript→vault export), #1247 (job-search vault
writes, parked).

**Grounded on:** `origin/main` = `2852a12c3`; issue #1248 body + 2026-07-24 / 2026-08-10 /
2026-08-13 comments; code fact-check of the ingestion, retrieval, and vault-writer paths (this
session, 2026-08-12). Surfacing decision (blend into notes surfaces, not a new tool) ruled by Ben
in this session.

## Decision summary

The internal vault (`@moss/vault`, `getVaultBaseDir()`) is write-mostly today: first-party
features write markdown notes into it, but the vault→index ingester has no production caller, so
nothing written there is ever searchable. This spec wires that bridge, scoped and fail-closed:

1. **Allowlisted vault note roots get ingested** into the existing memory chunk index under the
   already-reserved `source_kind='vault'` — people-notes and structured-state entity notes, `.md`
   only. Nothing else: `attachments/` and `exports/` stay out, and a future writer becomes
   searchable only by explicitly registering its root.
2. **Ingestion is a reconcile sweep plus a freshness nudge** — a scheduled pg-boss sweep
   (ingest changed files, purge deleted ones) mirroring notes-sync, plus a metadata-only job
   enqueued after each allowlisted note write so new content is searchable within ~1 minute.
3. **Surfacing blends into the existing notes surfaces** (Ben's ruling, option A): `notes.search`
   returns vault chunks alongside Obsidian-note chunks, each result labeled with its source;
   the #1553 notes-recall port gains the same blend once #1556 lands. No new tool.
4. **Two already-built consumers light up as a deliberate effect:** briefings' vault-chunk
   retrieval and the connector action-row relevance check both already query
   `source_kind='vault'` and have been receiving empty results since they shipped.

Owner-only privacy is structural and pre-existing: every chunk is stamped with the vault
context's `actorUserId`, and owner-only RLS on the memory tables is already live.

## Current-state grounding

Two stores are both called "vault" — do not conflate (per the 2026-07-24 correction on #1248):

- **Obsidian notes** (`JARVIS_NOTES_ROOTS`) are already ingested by notes-sync
  (`packages/notes/src/jobs.ts`, `NOTES_SOURCE_KIND = "notes"` at `:29`, 15-min schedule + manual
  route) and searchable via `notes.search`. Not this spec's subject.
- **The internal vault** (`getVaultBaseDir()`, all I/O through `VaultContext`) is the app-managed
  store this spec is about.

The dormant bridge and its ready consumers:

- `IngestionService.ingestVault()` (`packages/memory/src/ingestion-service.ts`) walks the vault,
  filters to `.md`, ingests per-file in per-file transactions, and purges index entries for
  deleted files on full runs. It has **no production caller** — CLI entrypoint only.
- `MemoryIngestPipeline.ingestFile()` (`packages/memory/src/ingest.ts`) hash-skips unchanged
  files, chunks + embeds, and writes with `SOURCE_KIND = "vault"` (`ingest.ts:12`), owner-stamped
  from `vaultCtx.actorUserId`.
- The `source_kind` CHECK on `app.memory_chunks` already allows `'vault'`
  (`packages/memory/sql/0106_memory_notes_source_kind.sql`). RLS on `memory_chunks` /
  `memory_file_index` / `memory_links` is owner-only (`0030_memory_index.sql`), with worker-role
  policies in `0054_worker_memory_rls.sql`. **No schema or migration work is needed.**
- **Waiting consumers:** briefings compose retrieves vault chunks per section
  (`packages/briefings/src/compose.ts:203-205`) and its deps report vault freshness via
  `getLatestIngestedAt(scopedDb, "vault")` (`packages/module-registry/src/index.ts` briefings
  deps); the connector action-row relevance port queries vault chunks
  (`packages/module-registry/src/index.ts:1057`). Both currently always see an empty index.
- **Chat cannot reach vault chunks at all:** `notes.search`
  (`packages/notes/src/tools.ts:51`) retrieves with `NOTES_SOURCE_KIND` only; #1553's passive
  retrieval is graph-facts + a notes-scoped recall port.

What actually writes markdown into the internal vault:

- **People-notes** (`packages/people/src/notes-service.ts`): canonical person notes at
  `<configured-folder>/<slug>.md` (`nextNotePath`, `:411-421`), written on create/update and
  projected back into people tables. The folder is a per-user preference. **This is the only live
  markdown writer today.**
- **Structured-state write-back** (`packages/structured-state/src/write-back.ts`): syncs entity
  frontmatter to `entity.vault_note_path` — but nothing in production currently sets
  `vault_note_path` on any entity, so this writer is dormant. It registers now so it is covered
  the day it goes live.
- **Not markdown, and out of scope:** chat attachments (`attachments/<id>/{blob,meta.json}`,
  `packages/chat/src/attachments-service.ts:20`), wellness/settings exports
  (`exports/<jobId>.html|.json`, `packages/wellness/src/export-job.ts:304`,
  `packages/settings/src/data-export-jobs.ts:141`).

## Goals

- A note Moss writes into the internal vault (today: a people-note) is searchable in chat within
  ~1 minute of the write, and surfaces through the same search reflex as Obsidian notes.
- Deleted vault notes leave the index: no ghost chunks answering from removed files.
- Every surfaced vault chunk carries provenance — source kind, vault-relative path, and modified
  time — so answers can say where they came from.
- Owner isolation holds end to end: a user's vault chunks are retrievable by that user only.
- The already-built vault-chunk consumers (briefings, action-row relevance) begin operating on
  real data with no code change of their own.

## Non-goals

- **Passive-retrieval behavior** (what gets injected pre-turn, budgets, gating) — owned by
  #1553/#1556. This spec only makes vault chunks *available* to that machinery.
- **Attachment content extraction** (text from uploaded blobs) — a real future feature, separate
  spec; `attachments/` is not allowlisted.
- **Export ingestion** — exports are derived duplicates of DB content; ingesting them adds no
  knowledge and widens the AI-visible surface for no gain.
- **Transcript→vault export** (#1368), job-search vault writes (#1247, parked), any write path
  into the user's Obsidian notes, any cross-user sharing of memory chunks.
- **Embedding/chunking changes** — the existing pipeline is used as-is.

## Design

### Ingestion allowlist (fail-closed)

- The memory module owns a registry of **ingestable vault roots**. An entry is a declared,
  owner-scoped path predicate supplied by the owning module through a public memory-module API —
  never by memory reaching into another module's config (module isolation).
- Initial registrations: **people-notes** (its per-user configured folder) and
  **structured-state** (its entity-note paths). Nothing else.
- The sweep intersects the vault's `.md` files with registered predicates; unregistered paths are
  never read by the ingester. `attachments/` and `exports/` are additionally hard-excluded as a
  belt-and-braces guard — a registration attempt covering them is a startup error.
- Fail-closed consequence, stated deliberately: a future vault writer ships **unsearchable by
  default** and must register its root in code review, where the "is this content safe to put in
  front of the model?" question gets asked. This is the secrets-never-escape invariant applied to
  ingestion.

### Trigger: reconcile sweep + freshness nudge

- **Sweep:** a pg-boss scheduled job (cadence mirrors notes-sync's 15-minute schedule; operator-
  configurable) runs `ingestVault`-equivalent logic per owner over the allowlisted roots:
  hash-skip unchanged files, ingest new/changed ones, then purge index entries whose files are
  gone. Purge reconciles against the filesystem, so deletions are caught regardless of which code
  path removed the file.
- **Nudge:** after a successful allowlisted note write, the owning module schedules a single-file
  ingest through the memory module's public API. Payload is **metadata-only**: owner id,
  vault-relative path, op — never content (hard invariant). The nudge is best-effort; the sweep
  is the guarantee.
- Which pg-boss queue shapes, dedupe keys, and per-owner iteration the sweep uses are plan
  decisions; the spec fixes the bounds: written→searchable ≤ ~1 minute via nudge, deleted→purged
  by the next sweep, and a broken embed of one file must not stop the rest (the per-file
  transaction pattern already in `ingestion-service.ts` is kept).

### Surfacing: blend into notes surfaces (Ben's ruling)

- **`notes.search`** queries both source kinds and merges by score. Each result gains a `source`
  label (the user's own notes vs. Moss-written internal note) plus vault-relative path and
  modified time. The result-shape change is additive; the tool description is updated so the
  model knows internal notes are covered (the manifest schema is the model's only view).
- **#1553 notes-recall port:** once #1556 lands, the port's implementation adds the vault kind to
  its query; the port *contract* (owner-scoped path, modified time, score, sanitized snippet)
  already fits and does not change. Sequencing is explicit: this work must not touch the port
  while #1556 is mid-build.
- **All #1553 gates apply unchanged and are not re-specified here:** incognito, `recallEnabled`,
  the credential/secret screen, untrusted-content fencing. Vault chunks flow through the same
  seams as notes chunks; this spec adds no new path to the model that bypasses them.
- **Waiting consumers light up:** briefings' vault section and action-row relevance start seeing
  real chunks. No changes to either; this is them working as originally designed. Their existing
  caps bound the effect.

### Privacy and provenance

- Owner scoping is structural: chunks are stamped from `vaultCtx.actorUserId` at ingest; RLS is
  already owner-only; retrieval runs under the actor's data context. No new policy work.
- Provenance is carried, not invented: `source_kind` + `source_path` already exist per chunk;
  modified time comes from the file index. Surfacing includes all three.
- People-notes can contain sensitive personal content by design — that is exactly the content the
  user wants Moss to know. The protection is owner-only scoping plus the #1553 screens, not
  content filtering at ingest.

## Acceptance criteria

1. **Deterministic ingest tests:** (a) an allowlisted `.md` write is chunked under
   `source_kind='vault'` with the owner stamped; (b) a non-allowlisted path (an `attachments/`
   or `exports/` file, or an unregistered root) is never read or ingested — asserted at the
   ingester; (c) re-running the sweep on an unchanged vault is a no-op (hash skip); (d) deleting
   a note then sweeping removes its chunks and file-index row; (e) one file failing to embed
   fails only that file, and the failure is visible in job stats/logs.
2. **Deterministic surfacing tests:** (a) `notes.search` returns a blended, score-merged result
   set with correct `source` labels, paths, and modified times; (b) owner isolation — user B
   never retrieves user A's vault chunks (RLS-level test); (c) the notes-recall port blend
   carries the same provenance and passes the existing port-contract tests unchanged.
3. **Freshness bound:** integration test proves a nudged write is retrievable within the bound
   without waiting for the sweep.
4. **Live-path gate (recorded on the PR):** on a live dev instance, tell Moss a fact about a
   person in chat so it writes/updates a people-note; in a **fresh session**, ask a question
   answerable only from that note without naming it — the answer uses the note and can cite it.
   Verify a real reply record exists, not just an HTTP 200.
5. **Consumer proof:** after ingestion runs, a briefing composed for a user with vault content
   includes vault-sourced material within its existing caps (log or output evidence).

## Rollout

No migration, no new tables, no schema change. Ships as: memory-module registry + sweep/nudge
jobs, `notes.search` blend, and registrations in people/structured-state. Default-on; the sweep
schedule is operator-configurable and the nudge degrades to sweep-only if job scheduling fails.
The notes-recall-port blend lands as a follow-up commit sequenced after #1556 merges. Live-proof
on the dev instance before merge per the live-path gate.

## User-facing summary

Moss already writes things down for you — notes about people, for a start — but until now it
could never find them again when answering. With this change, what Moss writes into your personal
vault becomes searchable in chat within about a minute, answers can cite which note they came
from, deleted notes stop being searchable, and briefings can draw on this content too. Your vault
content stays yours alone: it is only ever searchable by you.
