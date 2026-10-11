/**
 * Digital near-silence heuristic, not voice-activity detection: every PCM16LE sample
 * must be at most 32 counts (about -60 dBFS). Peak rather than whole-clip RMS keeps
 * short quiet speech above that floor, even in a long otherwise-silent clip.
 * Speech entirely below the floor can be missed; never normalize or filter text.
 * Input has already passed decodeCaptureAudio's format/length validation.
 */
export function isNearSilentCapturePcm(pcm: Buffer): boolean {
  for (let offset = 0; offset < pcm.length; offset += 2)
    if (Math.abs(pcm.readInt16LE(offset)) > 32) return false;
  return true;
}
