# Long Meeting summaries - build plan

Issue #3840. Design note is
[the long summaries design](../specs/2026-10-29-long-meeting-summaries-design.md).
Prod already has #3837, so all piece calls reuse the no-tools route it
added. This plan is one PR.

## Seams check

Every item was read in the current tree before this plan was written.

- The refusal lives in the meeting output runtime in the module registry
  package. It builds one prompt from the full inputs, compares its byte
  length with the shared structured prompt cap, and throws
  meeting_output_input_too_large before any call.
- The same runtime already resolves the model once, checks the route did
  not change around each call, and retries once on a bad shape. Piece calls
  reuse all of that per piece.
- The evidence checker in the meetings package validates an answer against
  a given set of inputs. Giving it the evidence seen so far is enough to
  check a piece answer, and the service already re-checks the final answer
  against the full inputs before saving.
- Transcript evidence is per segment, with offsets inside the segment.
  Notes evidence is offsets into the whole notes string. Only notes
  offsets need shifting when a piece sees a slice.
- Imported recordings can carry up to 20,000 segments and 1,200,000
  characters into a summary, so cutting must be by prompt bytes, not by a
  fixed segment count.
- The conversation summary job in the chat package shows the house pattern
  for fitting work under the same cap. It measures the real prompt bytes
  instead of estimating tokens. This plan does the same.
- Automatic summaries already run as a metadata-only job on the existing
  meetings queue. The queue currently allows 180 seconds before it treats
  a job as stuck, and the service stops generation at 110 seconds. Both
  numbers are in the meetings package and can grow there.
- The Meeting screen already polls while an automatic summary is pending
  and already renders plain writing and failed states. No UI change is
  needed for a longer run.

## Determinism boundary

The screen renders from the saved meeting record, never from model output.
The model gets one job, returning the summary object for the evidence in
front of it. The one new instruction tells it to merge the running summary
with the new piece and keep earlier evidence references. It is under 150
words. Cutting, offset shifting, checking, retrying, and saving are code.

## Task 1 - piece cutting in the meetings package

Add a pure cutting helper beside the output validation code.

- Exported shape: a piece is a set of summary inputs holding a slice of
  the segments and a contiguous slice of the notes, plus the notes slice
  start offset. A second exported helper shifts notes evidence in a piece
  answer back to full-notes offsets.
- The helper takes a fits check from its caller and packs whole segments
  in order until the next segment would not fit. Notes advance in slices
  of at most 1,000 characters, cut at a space or newline when one is near.
- When everything fits in one piece, the helper returns the inputs
  unchanged. That is the short path, and it is the same object the runtime
  sends today.

Tests state behaviour and why a broken build fails.

- A long transcript cuts into pieces in order, with no segment repeated or
  dropped. Dropping the ordering or the seen-so-far tracking fails this.
- Notes slices are contiguous, cover the whole notes, and shifted evidence
  lands on the same words in the full notes. Removing the shift fails
  this.
- Inputs that fit return as one unchanged piece. Cutting them anyway
  fails this.

## Task 2 - piece-by-piece generation in the meeting runtime

Rework the generator in the module registry runtime around pieces.

- Build today's prompt first. If it fits, make exactly one call, as
  today.
- Otherwise cut pieces with a reserve for the running summary, then call
  once per piece. Each later prompt carries the running summary and the
  merge instruction. Before each call, if that piece's prompt is still
  over the cap, cut the piece in half and queue the second half next.
- Check each piece answer against the evidence seen up to that piece,
  after shifting its notes evidence. Keep the existing one retry per
  piece on a bad shape, a parse failure, or a failed evidence check.
  Finished pieces are never resent.
- Keep the route checks from #3837 around every piece call. A route that
  changes mid-run fails the run with the existing route-changed code.
- The final answer goes back through the untouched service path, which
  re-checks it against the full evidence and saves it as one version.
- Raise the service generation deadline to 10 minutes and the automatic
  summary queue's stuck limit to match, plus a minute of slack. The
  generation reservation must also outlive that deadline. It defaults to
  two minutes, and the first live run proved what that does. The pieces
  finished, then the finished run was discarded as interrupted at save
  time. The reservation now gets the same ten minutes plus a minute.

Tests state behaviour and why a broken build fails.

- A transcript over the cap produces more than one model call and one
  saved-shape answer whose evidence cites segments from the first and
  last pieces. A single-call build fails with too-large instead.
- A short transcript makes exactly one call with a prompt equal to
  today's. Cutting it fails this.
- When the second piece first returns a bad shape, only the second piece
  is resent. Resending the first piece fails this.
- When a later piece cites a segment from an earlier piece, the answer
  still checks. Checking only against the current piece fails this.
- A notes citation from the second notes slice saves with full-notes
  offsets. Skipping the shift fails the final check.

## Task 3 - words, app map, and release note

- Update the grounded outputs feature declaration in the meetings
  manifest. Long recordings no longer end at the too-large error, so that
  error declaration is removed or rewritten to name only the single
  segment edge, and the feature text says recordings of any length are
  summarised piece by piece.
- The screen wording does not change. Writing and failed states already
  cover a long run.
- Release note, Fixed: long recordings now get summaries.

## Verification

Every command runs unpiped so the exit code survives.

```bash
pnpm vitest run tests/unit/meeting-output-runtime.test.ts tests/unit/meeting-output-chunks.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"
npx tsc --noEmit > /tmp/tsc.log 2>&1; echo "EXIT=$?"
npx eslint packages/module-registry/src/meeting-output-runtime.ts packages/meetings/src --max-warnings=0 > /tmp/lint.log 2>&1; echo "EXIT=$?"
```

Expected exit code is 0 for each. The full gate runs through the
verify-gate skill's script, never bare.

Live proof runs on a real dev instance through the real Meeting screen.
One imported recording carries a stand-in transcript long enough to push
the single prompt over the cap, built through the app's own import path,
and one short recording proves the single-call path. The stand-in is
disclosed on the PR. No network responses are faked. Both runs and their
evidence are recorded on the PR.

## Kill gate

Task 2 ships alone first inside this PR. If the piece answers cannot keep
evidence checking green against the full inputs on the live Claude route,
the chunked path does not ship and the PR stops with the finding recorded.
Ben makes that call from the live proof.

## Out of scope

- The 64 KiB cap and the shared AI package. If the fix seems to need
  either, stop and report instead of editing.
- Persisting pieces between runs, piece-count progress on screen, and
  parallel piece calls.
- Chat summaries, transcription, and provider settings.
