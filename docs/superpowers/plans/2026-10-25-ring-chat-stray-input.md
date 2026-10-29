# Ring chat stray input fix

Follow-up for #3584 under the approved
[spec](../specs/2026-10-20-vocci-automatic-delivery.md) and
[plan](2026-10-24-vocci-normal-chat-input.md). Handoff:
`docs/superpowers/handoffs/2026-10-25-ring-chat-stray-input.md`. One slice, no migration.

## Bugs and decisions

1. **Misplaced placeholder.** `mergeVoiceInputRecords` splices a receipt with no saved
   records at `records.length`, so it lands after newer typed turns.
   - Add optional `createdAt` to `TranscriptRecord`; `recordsFromMessages` copies the
     message timestamp onto each record it builds.
   - A placeholder (user bubble or status row) goes before the first timestamped record
     newer than the receipt, or before the next voice turn, whichever is earlier. Records
     with no timestamp (live, unsaved) count as newest.
2. **Punctuation-only transcript.** Add `hasSpokenText(text)` to `@moss/shared`
   (`/[\p{L}\p{N}]/u`).
   - Server: `VoiceRequestRepository.admit` sets `no-speech` when the transcript has no
     spoken text. The row and its transcript are kept as the receipt; nothing is queued.
   - Web: a receipt without spoken text never becomes a user bubble, in any state. It
     renders as a status row. This also covers the receipt already stored as `interrupted`.
3. **Interrupted notice.**
   - Copy becomes "Moss was interrupted before replying. Anything it started may not be
     done." with no pointer to Main chat.
   - The notice shows only while its turn is the latest user turn in the transcript. Any
     newer message clears it. Server state is unchanged, so no deletion endpoint.
   - Update the app-map entry (chat manifest `features`, core map if it names it) with the
     notice and when it clears.

## Tests first

- `tests/unit/chat-voice-input-records.test.ts`: placeholder after a newer saved typed
  message stays before it; punctuation-only interrupted receipt gives a status row, not a
  bubble.
- `tests/unit/chat-voice-review.test.tsx`: interrupted notice shows when latest, hides after a
  newer user turn; copy has no "Main chat".
- `tests/integration/chat-voice-requests.test.ts`: transcript `"."` admits as `no-speech`,
  never queues, keeps the transcript; replay is idempotent.

## Verification

Scoped `pnpm exec vitest run` on the unit files, `pnpm verify:static` unpiped, integration
via `scripts/run-gate.sh` (verify-gate). Independent Standards and Spec review of the
immutable head on a different model. Live proof on an isolated instance with a seeded
legacy request (`scripts/proofs/seed-legacy-voice-input.ts`), through the real chat UI.
