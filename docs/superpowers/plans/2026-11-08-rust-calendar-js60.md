# JS-60 Calendar continuation

Card 525. Part of #4027. Work in the task worktree under `~/Jarv1s`.

The approved objective is complete Calendar parity. JS-54 merged as PR #4055;
its report remains the exact inventory of missing execution and composition work.

## Implementation order

1. Build Calendar Day, Week and Month screens in a standalone Leptos crate using
   the shared module UI kit, opaque-frame bridge and authored Calendar styling.
   Keep all-day exclusive ends, midnight clipping, timezone conversion, overlap
   layout, event details, navigation, loading, retry and retained-data behavior.
2. Package actual built UI bytes alongside the guest, declare truthful screens
   and app-map metadata, and add installed-package checks plus real browser proof.
3. Close remaining routes/tools and provider/job execution through declared public
   adapters. Never replace provider writes with cache writes or read sibling tables.
4. Run the disposable Calendar gate, native/UI checks, independent review and live
   signed-in UI/device verification. Full acceptance requires all remaining JS-54
   obligations; a partial checkpoint must say exactly what is not proven.

Use separate guest/host/UI Cargo targets. Database work runs only through
`scripts/run-gate.sh`. No global installation. Generated builds and evidence stay
outside commits. If the full scope would require more than one compaction, follow
Ben's checkpoint rule: commit tested work, push one checkpoint PR, and leave the
remaining acceptance list explicit. Do not mark Calendar fully accepted.
