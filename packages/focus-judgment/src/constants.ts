/**
 * The service key an admin binds a model to, in Settings → AI. Focus is platform code, not a
 * module, so the key is a plain constant here; the binding check accepts it because `trail-marker`
 * is a platform-owned namespace (see the model-binding route in the AI package).
 */
export const FOCUS_JUDGE_SERVICE_KEY = "module.trail-marker.judge" as const;

/** One nudge per person per this many minutes, across every block and every linked Mac. */
export const FOCUS_NUDGE_CAP_MINUTES = 45;

/** How long the Mac's own request waits for the judgment model before giving up. */
export const FOCUS_JUDGE_TIMEOUT_MS = 20_000;

/** Enough for a label and a 140-character reason, with room for the model's formatting. */
export const FOCUS_JUDGE_MAX_OUTPUT_TOKENS = 256;
