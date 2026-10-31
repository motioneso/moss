# Reviewed merchant-rule management

Authorized Finance parity continuation, extending #1144/#1147. Commit and push the isolated branch;
no PR publication, merge, deploy, real credentials, banks or live financial actions.

The official [Monarch rules guide](https://help.monarch.com/hc/en-us/articles/360048393372-Transaction-Rules),
checked October 30, covers rule management, preview and optional retroactive application, with many
criteria/actions. Moss's existing rule engine matches one normalized payee to a category. Preserve
that bounded contract rather than presenting it as Monarch's broader engine.

## Canonical state and compatibility

Add an owned merchant-rule table through additive module SQL. Rule identity remains the existing
normalized-payee hash; show the normalized match text before saving because digits and punctuation
are stripped by the established normalizer. Store category, enabled state and timestamps. A disabled
row is a durable tombstone and must not revive an old KV rule. Owner RLS applies, including admins.
Keep historical KV values intact; do not delete them as part of this cutover.

The ordinary storage migration copies the newest valid legacy rule for each normalized payee with
insert-if-absent semantics. Existing canonical rows always win. Copy categories first, then rules,
and mark this owned rules upgrade complete only after successful copy. The already-migrated-owner
path must also perform the upgrade. Keep original per-owner ledger migration markers and all money
unchanged. Malformed legacy data must not be silently deleted or reported as fully migrated.

Until upgrade completes, native management reports that rules are getting ready and offers explicit
read retry. Existing runtime categorization merges legacy rules with canonical overrides, including
disabled tombstones. All current SQL rule writers, including chat, queued rule creation and Undo,
use the canonical rule capability; KV-only hosts keep their compatibility behavior. Rule-plus-row
category writes remain separate and must still be described as such. Older concurrently running
hosts are a separate compatibility boundary, not proof of global convergence.

Native management captures row revisions. A guarded single statement checks the expected rule row
(or expected absence), validates a live destination category, writes rule metadata and identifier-only
activity atomically. Concurrent/stale edits save nothing. Category Undo restores rule configuration,
reversal activity and the original undone marker together; repeated, stale, foreign or unavailable
restores save nothing. No merchant prose, notes or transaction contents enter activity or job payloads.

## Native workflow

Finance settings gains a Merchant rules section with explicit loading/empty/error/retry states,
server-side normalized search, honest loaded/total counts and bounded Show more. List merchant match,
category and enabled state. Add, edit category, disable and re-enable use captured review and the
existing host tools confirmation contract. Changing the match creates a separate rule; do not silently
rename its identity. Archived categories retain history and require a live destination to enable.

A read-only preview shows recent owned matching transaction examples for a selected month, exact
currency/money/date and current category, with a count and explicit loaded limit. State that saves
apply to future uncategorized arrivals, never retroactively edit these examples or overwrite user
allocations. Do not auto-post, import or contact a bank. No automatic write retry; retain cancellation
and typed values, block ambiguous/stale saves until explicit successful reload, suppress duplicates.
Use authored Park Press primitives, semantic colors and calm responsive rows/dialogs.

## Acceptance

Use synthetic data and actual module installation. Prove additive upgrade from legacy KV, newest
precedence, canonical overwrite protection, disabled-rule non-resurrection, archived/live category
checks, owner/admin RLS, atomic activity, concurrent and held-lock stale rejection, Undo and metadata
preservation. Observe concurrency/RLS protections fail under a fixture negative control, restore and
prove green. Exercise the actual settings page, host guard, workers, SQL, future categorization and
reload, including cancel/stale/error states and desktop/phone light/dark/Sage screenshots. Preview
must not mutate history. Run relevant unit, migration/SQL, lint/types/static, installed browser and
aggregate checks. Keep the app map and evidence-linked parity matrix precise; multiple criteria,
ordered actions, tags, automatic splits and retroactive rule application remain separate gaps.
