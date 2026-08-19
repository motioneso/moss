# #1708 — Attachment indexing: sent attachments become searchable

**Date:** 2026-08-19

**Status:** Proposed

**Issue:** [#1708](https://github.com/motioneso/moss/issues/1708)

**Grounded on:** `origin/main`; issue #1708 body and the 2026-08-19 triage comment; code
fact-check of `packages/chat/src/attachments-service.ts`, `packages/memory/src/ingest.ts`,
`packages/memory/src/vault-ingest-jobs.ts`, `packages/memory/src/repository.ts`,
`packages/notes/src/tools.ts`, and the approved
`2026-08-12-1248-internal-vault-ingestion.md` spec (which explicitly parked attachment
extraction as "a real future feature, separate spec").

## Context

A user can attach files to a chat message today — paystubs, offer letters, separation
documents, images. `ChatAttachmentsService` (`packages/chat/src/attachments-service.ts`)
already writes the bytes into the actor's own vault under `attachments/<id>/{blob,meta.json}`,
and `markSent` stamps `sentAt` on an attachment once it is actually included in a turn. A
24-hour TTL reaper only removes attachments that were uploaded and never sent
(`sweepAndCountPending`, spec-referenced as "§6" in that file) — a sent attachment is never
deleted by that sweep. So **the file is not going anywhere**. The gap is that once the
conversation that sent it ends, nothing can find it again: there is no search or recall path
into attachment content, so a user who asks "what was my base salary on that offer letter" in a
later conversation gets nothing, and has to re-upload the file.

This is deliberately scoped as a search/recall gap, not a storage gap. `packages/chat/src/attachments-service.ts`
already extracts text from PDF and DOCX attachments (`extractPdfText`, `extractDocxText`) and
caps it at `ATTACHMENT_TEXT_CAP_CHARS` (15,000 characters) before handing it to the model
(`capText`). That extracted text is exactly the content this spec proposes to index — no new
extraction step, no new store.

The prior #1248 spec built the bridge from the internal vault into the existing memory chunk
index (`app.memory_chunks` / `app.memory_file_index`, `source_kind` column) for markdown notes,
and explicitly excluded `attachments/` from its allowlist, calling out attachment-text indexing
as future work. This spec is that future work.

## Goals

1. Once an attachment has been sent in a chat turn, its extracted text becomes searchable in a
   later conversation through the same reflex the model already uses for notes
   (`notes.search`), without a new tool.
2. Indexing only ever runs on attachments that were actually sent (`sentAt` set). Pending,
   never-sent uploads are never indexed — consistent with the existing invariant that only sent
   attachments get retained past the 24-hour TTL.
3. The indexed text is the same capped, already-extracted text the model already saw
   (`ATTACHMENT_TEXT_CAP_CHARS`) — not a second extraction with a different cap or a different
   code path.
4. A search result answers "which attachment did this come from" — file name and sent date at
   minimum — so an answer can say where it got the information.
5. Owner-only privacy holds end to end: an attachment is retrievable in search by its uploading
   owner only, with the same structural guarantee the vault and memory index already provide.
6. Deleting the underlying attachment (a future deletion feature, or a fixed retention window,
   if one is ever added) must be able to remove its chunks too — the index cannot outlive the
   source file it was built from.

## Non-goals

- Any change to attachment upload, storage, size limits, mime allowlist, or the pending-upload
  TTL reaper. Sent-attachment retention policy (how long a sent attachment's blob lives) is out
  of scope; this spec assumes today's "sent attachments stick around" behavior and indexes
  whatever exists.
- A dedicated attachments store, browser, or management UI. This spec reuses the existing memory
  chunk index; it does not introduce a new table or a new product surface for attachments.
- Image attachments. Only the `text` kind extraction (`pdf`, `docx`, `text`) produces extracted
  text today; images have no extracted text to index, so they are not covered by this pass. A
  future OCR or image-captioning step is separate work.
- Any change to `notes.search`'s query semantics, ranking, or the #1553 passive-retrieval
  gating (incognito, `recallEnabled`, credential/secret screening, untrusted-content fencing).
  This spec adds a new source kind that flows through those existing seams unchanged, the same
  way #1248 added the `vault` source kind without touching them.
- Re-indexing or backfilling attachments sent before this feature ships. Only attachments sent
  after this feature is live are indexed. A backfill is a follow-up if wanted.
- Any change to the 15,000-character cap or to what text the model sees at send time.

## Design

### Trigger: index on send, not on upload

`ChatAttachmentsService.markSent` (`packages/chat/src/attachments-service.ts:236`) is the single
place that already knows an attachment graduated from "pending" to "sent" — this is the same
signal the TTL reaper already uses to exempt it. After `markSent` stamps `sentAt`, the chat
route enqueues one metadata-only pg-boss job per sent attachment: owner id, attachment id,
op — never the extracted text itself, matching the metadata-only job payload invariant that
`memory.vault-ingest-nudge` already follows for vault notes.

Nothing is indexed at upload time. An attachment that is uploaded and abandoned (reaped by the
existing 24-hour TTL sweep) is never indexed, because it never reaches `markSent`.

### New source kind: `attachment`

Add `'attachment'` to the `source_kind` CHECK constraint on `app.memory_chunks` and
`app.memory_file_index`, following the same widen-the-constraint migration pattern used for
`'chat'` (`0040_memory_chat_source.sql`) and `'notes'` (`0106_memory_notes_source_kind.sql`).
`source_path` for an attachment chunk is `attachments/<id>`, matching the vault-relative path the
file already lives at — the memory index's existing `(owner_user_id, source_kind, source_path)`
uniqueness constraint needs no change.

### Ingest path: text in, not a vault-file read

The existing `MemoryIngestPipeline.ingestFile` (`packages/memory/src/ingest.ts`) reads a vault
file itself and runs it through the markdown-oriented `parseDocument` (frontmatter stripping,
`## `-heading splits, wikilinks). Attachment text is not markdown and has already been extracted
and capped by `ChatAttachmentsService`, so this spec adds a sibling ingest entry point that takes
already-extracted text directly — `parseDocument`'s generic paragraph/line chunking (the part
below its markdown-specific frontmatter and heading handling) is reused for the size-bounded
splitting, so no new chunking logic is written.

The nudge job handler:

1. Loads the attachment's stored metadata and reads its content through the existing
   `ChatAttachmentsService.readContent`, under the actor's own vault context — this is the exact
   same call the chat turn used to build the model's prompt, so the indexed text and the text the
   model already saw are guaranteed to match.
2. Skips indexing when `readContent` returns `"missing"` (attachment was deleted between send and
   the job running) or resolves to an image (`kind: "image"`, no text).
3. Chunks and embeds the extracted text and writes it with `source_kind = 'attachment'`,
   `source_path = attachments/<id>`, stamped with the actor's owner id — the same
   `MemoryRepository` write path every other source kind already uses.
4. Records a file-index row keyed on the same `(owner id, 'attachment', attachments/<id>)` tuple
   so a re-run (e.g. a retried job) hash-skips unchanged content instead of duplicating chunks.

No sweep job is added. Unlike vault notes, attachments are not walked from a filesystem listing
of allowlisted roots — the nudge is the only trigger, fired once per attachment at send time. If
the nudge fails (job scheduling failure, one bad file), the attachment's text is simply never
indexed; the failure is visible in job stats/logs the same way a single-file ingest failure
already is for vault notes. There is no periodic catch-up sweep in this pass — see Open
Questions.

### Surfacing: same blend `notes.search` already does for vault chunks

`notes.search` (`packages/notes/src/tools.ts`) already queries a `source_kind` and, per the
#1248 design, blends multiple source kinds into one score-merged result with a `source` label.
This spec adds `'attachment'` as a third blended kind alongside `'notes'` and `'vault'`. Each
attachment-sourced result carries:

- `source: "attachment"`
- the attachment's file name and sent date (read from the stored `StoredAttachmentMeta`, not
  re-derived), so an answer can say "from your offer-letter.pdf upload"
- the matched chunk text, through the same untrusted-content fencing every other search result
  already gets — attachment text is user-supplied document content and must be treated exactly
  like note or vault text, never as instructions

The #1553 passive-retrieval and recall-port gates (incognito, `recallEnabled`, credential/secret
screening) apply unchanged; this spec adds a source kind, not a new path to the model.

### Privacy and provenance

- Owner scoping is structural, unchanged from the rest of the memory index: chunks are stamped
  from the actor's own id at ingest, RLS on `memory_chunks` / `memory_file_index` is already
  owner-only, and retrieval runs under the actor's data context. No new policy work — this is the
  same guarantee #1248 relied on for vault notes.
- The nudge job payload is metadata-only (owner id, attachment id, op) — the extracted text
  itself is never written into a job payload, matching the existing hard invariant and the
  pattern already used by `memory.vault-ingest-nudge`.
- Attachment content can be as sensitive as a paystub or offer letter by design — that is exactly
  why the user attached it and exactly what they expect to be able to recall later. The
  protection is owner-only scoping plus the existing #1553 recall screens, not content filtering
  at ingest — the same stance #1248 took for people-notes.
- Deleting the source attachment must be able to remove its chunks (Goal 6): the file-index row
  keyed on `attachments/<id>` gives a deletion path the same shape as the vault sweep's purge-on-
  delete, even though this spec does not add a periodic sweep that performs it automatically (see
  Open Questions).

## Security and Privacy

- No change to `AccessContext`, `VaultContext`, RLS policy, or any admin capability. No admin
  bypass of owner-only attachment content — admins have configuration power only, unchanged.
- No new secret or credential handling. The job payload is metadata-only, matching the
  pg-boss/secrets-never-escape invariant.
- Indexed text is exactly the text already shown to the model at send time (same extraction, same
  15,000-character cap) — this spec does not widen what leaves the vault in any new direction, it
  makes the same content newly searchable by its own owner.
- Migration only widens a CHECK constraint; no new table, no data backfill, no change to an
  applied migration file.

## Verification

### Focused automated checks

1. An attachment marked sent triggers exactly one nudge job carrying only owner id, attachment
   id, and op — never text.
2. The nudge handler indexes a sent PDF/DOCX/text attachment's extracted text under
   `source_kind = 'attachment'`, stamped with the correct owner, and skips an attachment whose
   `readContent` resolves to `"missing"` or `"image"`.
3. A pending (never-sent) attachment produces no nudge job and is never indexed, including after
   the 24-hour TTL reaper would have removed it.
4. `notes.search` returns a blended result including an `attachment`-sourced chunk with the
   correct `source` label, file name, and sent date, alongside `notes`/`vault` results.
5. Owner isolation: a chunk indexed from user A's attachment is never retrievable in user B's
   search, asserted at the RLS/query level, not just at the application layer.
6. Re-running the nudge for an unchanged attachment (e.g. a retried job) does not duplicate
   chunks — hash-skip behavior, mirroring the existing vault-ingest test for the same case.
7. Indexed text matches the capped extraction exactly — no independent extraction or cap drift
   between what the model saw and what search returns.

### Required live-path proof

On the exact implementation head, on a live dev instance:

1. Sign in as a normal user, attach a text-bearing document (a PDF or DOCX with a distinguishing
   fact, e.g. a specific salary figure) to a chat message, and send it.
2. Start a **new, unrelated conversation** and ask a question answerable only from that
   document's content, without naming the file or repeating the fact in the new conversation.
3. Verify the answer surfaces the fact and can cite the attachment (file name/sent date), and
   confirm a real search/reply record exists — not just an HTTP 200.
4. As a second account, confirm the same query returns nothing from the first user's attachment.

Record the exact result and teardown evidence on the PR.

## Exit Criteria

- A sent chat attachment's already-extracted text is indexed under a new `attachment` source kind
  in the existing memory chunk index, triggered by the same `markSent` signal the TTL reaper
  already uses — no attachment is indexed before it is sent.
- `notes.search` surfaces attachment-sourced results blended with notes and vault results, each
  labeled with its source, file name, and sent date.
- A later, unrelated conversation can recall a fact from a previously sent attachment, and the
  live-path proof above is recorded on the implementation PR.
- Owner-only privacy holds structurally: no new query path, admin bypass, or cross-user access is
  introduced.
- No new table, no attachment-store rework, no change to upload limits, extraction, or the
  pending-upload TTL reaper.
- Focused automated checks, repository static checks, CI, and the live-path proof are green.

## Open Questions

1. **Does a sent attachment ever need to be un-indexed?** Today, sent attachments have no
   deletion path and no expiry — they simply stick around. If a future feature lets a user
   delete a sent attachment, or a retention window is added later, this spec's chunk/file-index
   rows need a purge path keyed on `attachments/<id>`. Should this spec block on that path
   existing, or is "index now, purge later when deletion ships" acceptable given deletion doesn't
   exist yet?
2. **Is a periodic reconcile sweep needed, or is the one-shot nudge sufficient?** Vault-note
   ingestion has both a nudge (fast path) and a scheduled sweep (guarantee, plus deletion purge).
   This spec proposes nudge-only because there is no analogous "walk all attachment roots"
   operation and no deletion to reconcile against yet. If the nudge job fails outright (not
   retried, or retried past its limit), that attachment's text is permanently unindexed until a
   future manual or scheduled catch-up exists. Is that an acceptable gap for this pass, or does
   Goal 6 (index cannot outlive its source) argue for a minimal sweep now?
3. **Image attachments:** should a future pass add OCR or image captioning so a photographed
   document becomes searchable too, or is text-only extraction (today's status quo) the
   permanent boundary for this feature?
4. **Cross-conversation attachment references:** if a user re-attaches or references an
   already-indexed attachment in a later conversation, should the system recognize it's the same
   file (avoid re-indexing) or is send-time-triggered indexing with hash-skip on retry sufficient
   for that case too? (Current design treats every `markSent` as a nudge trigger; hash-skip in
   the file-index handles the exact-duplicate-content case, but two different attachment ids with
   identical bytes would currently index twice under two different `source_path`s.)

## Hard Invariants Honored

- Spec before build: this document must be approved before an implementation plan is written.
- Private by default / owner-only: attachment chunks are retrievable only by the uploading owner,
  via the same structural RLS guarantee the rest of the memory index already provides.
- No admin private-data bypass: nothing in this design grants admin read access to attachment
  content.
- Metadata-only job payloads: the nudge job carries owner id, attachment id, and op — never
  extracted text.
- Module isolation: chat continues to own attachment storage and extraction; memory continues to
  own the chunk index and embedding pipeline; they collaborate through the nudge job and the
  existing `ChatAttachmentsService.readContent` call, not by either module reaching into the
  other's internal tables.
- Never edit an applied migration: the `source_kind` widen for `'attachment'` is a new migration
  file, following the exact pattern of `0040_memory_chat_source.sql` and
  `0106_memory_notes_source_kind.sql`.
