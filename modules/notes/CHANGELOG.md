# Notes package

## 0.1.20

- Notes now repairs itself. Every fifteen minutes it picks up any sync request that was saved but never started, and it clears finished sync records two days after they complete.

## 0.1.19

- The chat module can now save a day's conversations as one file in your linked notes folder. A file of your own with the same name is never changed; the archive is saved beside it instead. Turning this on from chat settings is not available yet.

## 0.1.18

- Other modules can now save a versioned private copy of a note into your own private area, and check whether a copy exists. Copies are never overwritten and never appear in your linked notes folder. Indexing of these copies is not available yet.

## 0.1.17

- A linked notes folder now syncs on its own every fifteen minutes. Linking a folder or pressing Sync now sets up the schedule; unlinking cancels it. Automatic indexing recovery is not available yet.

## 0.1.16

- Ship the create, edit and delete chat tools, the manual sync request and the sync job in the package itself. Each write waits for your approval of the note as shown, and refuses a changed note or relinked folder. Settings, Connections gains a Sync now button. Scheduled sync and automatic indexing recovery are not available yet.

## 0.1.15

- Match legacy folder-request validation and coercion, including ignored extra fields and repeated directory-path errors. Invalid requests leave the link untouched; account selection stays with the server. Existing vault path restrictions still apply.

## 0.1.14

- Experimental installed writes can now bind approval to the displayed note version and refuse changed notes or relinked folders before writing or requesting sync. A new approval is needed after refusal. Ordinary chat writes remain unavailable.

## 0.1.13

- Match legacy responses for missing folders inside allowed roots and existing paths outside them. Missing paths outside roots still differ; vault policy refusals retain general guidance. The chooser explains the reason and keeps the entered path and current folder link after a rejected save. Existing vault path restrictions still apply.

## 0.1.12

- Bind experimental API sync requests to the selected folder, matching manual sync. Unlinked sources are refused before saving or queueing work; a later folder change cannot redirect a saved request. Installed production sync remains unfinished.

## 0.1.11

- Bind experimental create, edit and delete sync requests to the folder used by the write. Changing or unlinking the folder refuses pending indexing; selecting the original folder allows a retry. Installed chat and production sync remain unfinished.

## 0.1.10

- Add the experimental manual sync HTTP handler, preserving the missing-folder response and returning a durable request ID. Installed routing and account privacy are checked with the compiled component. Ordinary manual sync remains unavailable.

## 0.1.9

- Experimental sync recovery discovers saved unpublished requests in private, bounded pages without knowing their IDs. Completed pages are skipped; queue identities are reused. Ordinary sync remains unavailable.

## 0.1.8

- Connect experimental create, edit and delete tools to private durable sync checkpoints. Their queued work now resumes the same worker as manual requests. Installed chat approval and sync activation remain unfinished.

## 0.1.7

- Remember successful sync pages and reuse their continuation on retry. Independent workers serialize through the private checkpoint row. Sync activation remains unfinished.

## 0.1.6

- Save durable sync outcomes after transaction finalization, preserving previous results during continuations and after unlinking. Sync activation remains unfinished.

## 0.1.5

- Store private sync continuations in an owner-only package table. The test worker resumes by opaque ID and queues no paths or hashes. Production sync activation remains unfinished.

## 0.1.4

- Add the core-owned production file ingestion adapter behind the sync coordinator, with legacy document chunking, unchanged-file skipping and per-page indexing. Assembly, real embedding services, scheduling and write chat remain unavailable.

## 0.1.3

- Port sync coordinator and deleted-file selection into the test-only component, with actual legacy differential checks. Real indexing, scheduling, saved status and write chat remain unavailable.

## 0.1.2

- Add read-only search of existing indexed notes, with a core-memory adapter and installed guest comparisons. Query-provider assembly, sync and live chat remain unfinished.

## 0.1.1

- Add a read-only installed public API for legacy note action details and canonical account-bound source resolution; chat approval and sync execution remain unfinished.

## 0.1.0

Initial Rust package checkpoint: managed-source account export and existing Notes
domain operations. Chat tools, background sync, managed publication,
private note export, daily archives and the account export screen join are unfinished.

- Add Connections folder browse/link/unlink and saved sync status through installed guest routes; sync and chat remain unfinished.
- Keep rejected folder paths editable and use the shared frame launcher and document styles.
