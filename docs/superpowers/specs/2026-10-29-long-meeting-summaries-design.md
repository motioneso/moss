# Long Meeting summaries - design note

Issue #3840. Prod is on #3837, so every summary call already goes through the
no-tools route. The failure is size. One prompt holds the whole transcript
plus notes plus guidance, and the meeting runtime refuses it when it passes
the 64 KiB cap in the shared AI package. Ben's rule is that summaries work
regardless of recording length.

## How pieces are cut

- The runtime first builds the prompt exactly as today. When it fits, there
  is one call and nothing changes. Short recordings keep today's cost and
  behaviour.
- When it does not fit, the runtime cuts the evidence into pieces in order.
  A piece holds whole transcript segments, never part of a segment, plus a
  contiguous slice of the personal notes. Each piece is cut small enough
  that its prompt, with room left for the running summary, stays under the
  same 64 KiB cap. The cap itself does not move, and the shared AI package
  is not edited.
- A single segment or notes slice that still cannot fit is cut smaller at
  run time before its call. A piece with one segment that cannot fit even
  alone fails with the existing too-large code. That is the named edge, not
  a silent truncation.

## How pieces become one summary

- Piece one is summarised on its own. Each later piece is summarised with
  the running summary in front of it, and the model returns the whole
  updated summary each time. The last piece's answer is the result the
  Meeting screen already expects, with the same sections.
- Every piece call uses the existing structured call, so subscription
  models stay on the no-tools route from #3837 and API-key models stay on
  the route that has no tool access by construction. There is no new
  transport and no fallback route.
- Each piece gets the same one retry on a bad shape that a whole summary
  gets today. A retry repeats only the failed piece. Finished pieces are
  held for the rest of the run and are never sent again.

## How evidence stays real

- Transcript evidence names a segment and character offsets inside that
  segment. Segments are never cut, so those references need no rewriting
  and still point at the real segment.
- Notes evidence uses offsets into the notes text. A piece sees only its
  slice, so the runtime shifts notes offsets in that piece's answer by the
  slice start before checking them. After the shift they are offsets into
  the full notes, as today.
- Every piece answer is checked with the existing evidence checker against
  all evidence seen up to that piece, so a piece cannot cite a segment it
  has not been shown, and earlier citations stay checked. The service still
  runs the same final check against the full evidence before saving.
- The recording reading (title, type, side, ideas) rides in the same
  answer, as today. Later pieces can revise it as more evidence arrives.

## What the user sees

- Nothing new to learn. The screen already shows Writing summary while a
  request runs and a plain failed message with a retry when it fails, and
  both stay. A long summary simply runs longer.
- Because a long run takes several calls, the generation deadline grows
  from 110 seconds to 10 minutes, and the automatic summary job is allowed
  to run that long before the queue treats it as stuck. A run that still
  fails keeps the finished pieces out of the saved record, saves nothing
  half-built, and the failed state names the failure as today. Retrying
  starts a fresh run. No half summary is ever shown as a saved version.

## What does not change

- The 64 KiB cap and everything in the shared AI package.
- The saved summary shape, the version history, and task suggestions.
- Job payloads stay metadata only. Automatic summaries keep using the
  existing queue with actor, meeting, and request key, and no transcript
  text enters a payload, a log, or a receipt.
- No new table and no new screen state. Piece answers live only in memory
  for one run.

## Determinism boundary

- The screen renders from the saved meeting record, never from model
  output. The model keeps its one job, which is to return the summary
  object. New model wording is one short merge instruction, well under
  150 words. Everything else (cutting, offset shifting, checking, saving)
  is plain code.
