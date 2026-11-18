# Notes part three execution plan

Card: 524. Part of #4027. Work from the merged part-two checkpoint in `~/Jarv1s`.

Start with the actual SDK-based Notes guest and generated Wasm component, an unsigned
reproducible package builder, frozen legacy SQL inventory verification and the managed
source account-export contract. Register only implemented functionality in the manifest.
Keep Notes required, with no standalone screen or navigation entry.

Verify the real component under Wasmtime and install the signed test package through
the real PostgreSQL lifecycle. Compare exports with the existing TypeScript collector
on disposable data for app/worker roles, including another account and an unrelated
admin. Remove RLS in the disposable database, observe the same guest privacy assertions
fail, restore it and pass. Keep the six existing SQL privacy cases and domain vectors.
Run database work only through `scripts/run-gate.sh` and `modules/notes/tools/gate.sh`.

Then continue Settings, the four tools with approval, memory-backed sync and its schedule,
managed publication/cleanup, private exports and daily archives, and UI/device parity
as described in the report's seven-step plan. If this requires more than the brief's
context bound, stop at a clean tested commit and record exact unfinished work. Such a
checkpoint is not full Notes acceptance. Keep all prior filesystem limitations explicit.

Use the already approved wit-bindgen dependency locally, never install a global CLI.
Review the committed diff with fresh eyes and record the round on its reviewed commit.
