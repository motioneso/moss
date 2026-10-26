package ai.moss.vocci;

/** Conservative observation window, not a guessed capture duration. No recording controls. */
final class RecordingReminder {
    static final long AFTER_MS = 60 * 60 * 1000L, REPEAT_MS = 30 * 60 * 1000L, MAX_GAP_MS = 2 * 60 * 1000L;
    private String source = "";
    private long first, previous, due;
    private boolean dismissed;
    synchronized boolean observe(boolean enabled, String state, String key, long elapsed) {
        if (!enabled || !"recording".equals(state) || key == null || key.isEmpty()) {
            source = ""; dismissed = false; return false;
        }
        if (!source.equals(key) || elapsed < previous || elapsed - previous > MAX_GAP_MS) {
            source = key; first = elapsed; due = first + AFTER_MS; dismissed = false;
        }
        previous = elapsed;
        if (dismissed || elapsed < due) return false;

        // Repeat on a fixed cadence from the first reminder until dismissed.
        while (due <= elapsed) due += REPEAT_MS;
        return true;
    }

    /** Swiping or tapping the reminder silences it for the rest of this recording. */
    synchronized void dismiss() { if (!source.isEmpty()) dismissed = true; }
}
