import type { MeetingCaptureAudioInput, MeetingTranscriptSource } from "@moss/shared";
import type { CaptureStoredState } from "./capture-domain.js";

/**
 * Register every selected source through the completed clip's epoch together. Provider
 * completions may arrive in reverse order; a closed earlier epoch must not acquire its
 * first source after a newer one. Bounds use the authorized epoch interval, never an
 * invented duration for zero-length paused selection epochs. No transcript is fabricated.
 */
export function captureTranscriptSources(
  state: CaptureStoredState,
  input: MeetingCaptureAudioInput,
  retained: readonly MeetingTranscriptSource[]
): MeetingTranscriptSource[] {
  const sources = retained.map((source) => ({ ...source }));
  for (const epoch of state.epochs) {
    if (epoch.epoch > input.epoch) break;
    const endMs = epoch.epoch < input.epoch ? epoch.endMs : input.endMs;
    if (endMs === null || endMs <= epoch.startMs) continue;
    const selected: { sourceId: string; kind: "microphone" | "output"; label: string }[] = [
      ...(epoch.selection.microphone
        ? [
            {
              sourceId: epoch.selection.microphone.sourceId,
              kind: "microphone" as const,
              label: epoch.microphoneLabel!
            }
          ]
        : []),
      ...(epoch.selection.mode !== "microphone-only"
        ? [
            {
              sourceId: epoch.selection.outputSourceId,
              kind: "output" as const,
              label: epoch.outputLabel!
            }
          ]
        : [])
    ];
    for (const selectedSource of selected) {
      const existing = sources.find(
        (source) => source.epoch === epoch.epoch && source.sourceId === selectedSource.sourceId
      );
      if (existing) existing.endMs = Math.max(existing.endMs, endMs);
      else sources.push({ ...selectedSource, epoch: epoch.epoch, startMs: epoch.startMs, endMs });
    }
  }
  return sources;
}
