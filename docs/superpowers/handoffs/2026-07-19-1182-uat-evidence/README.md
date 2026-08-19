# #1182 — Hide embedding provider controls: live UAT evidence

Live visual QA for PR #1205 (issue #1182), rerun from the rebased PR head on a real isolated
instance provisioned by the repository’s #1000 UAT harness. Grounded on `origin/main@0ff7f468`.

## Instance

The harness allocated `http://127.0.0.1:20000` for this run and used an isolated Compose project
(`uat-1270587_86b92eca`) with a fresh migrated Postgres database and throwaway owner account.
The stack was torn down after capture; its containers, volumes, and network were removed.
No frontend API mocks or shared port `5178` were used.

## Results

**67 PASS / 0 FAIL / 1 INFO** across desktop (1280px) and narrow (375px) widths. The full matrix
is in `results.json`.

The run clicked and proved the requested state-changing controls at both widths:

- Set as default: clicked on a second provider; success toast and the new Default badge were seen.
- Credential Save: clicked after filling the real form; success toast and `API key stored` state
  were seen after reload.
- Voice Save: clicked with a new endpoint and again on the configured narrow form; success toast
  and the configured microphone copy were seen.

All previously proven controls remained in the sweep, including provider creation/removal,
terminal modal, authentication and execution segments, model controls, chat binding and lock,
web-search key, YOLO confirmation, and responsive absence assertions for `embedding`/`stub`.

The sole INFO is honest: the Voice Enabled switch is not rendered before the first endpoint save;
the desktop pass exercised its real Save gating, and the narrow pass exercised the configured
switch and Save path.

## Acceptance mapping

- Lines 41–42: both widths found no `embedding` or `stub` copy and zero embedding-labelled
  select/input DOM matches.
- Lines 46–47: every remaining interactive control in the assembled Assistant & AI pane was
  exercised at both widths; no control recorded FAIL.

Run provenance and durable output are kept under `~/Jarv1s/docs/superpowers/handoffs/` when this
artifact is viewed from the main checkout.
