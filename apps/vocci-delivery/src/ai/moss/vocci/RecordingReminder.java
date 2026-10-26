package ai.moss.vocci;

/** Conservative observation window, not a guessed capture duration. No recording controls. */
final class RecordingReminder {
    static final long AFTER_MS = 60 * 60 * 1000L, REPEAT_MS = 30 * 60 * 1000L, MAX_GAP_MS = 2 * 60 * 1000L;

    /** Process-wide so the notification's tap and swipe reach the service's tracker directly. */
    static final RecordingReminder SHARED = new RecordingReminder();

    private String source = "";
    private long first, previous, due;

    // Seeded from wall time so a notification from before a process restart cannot match.
    private long window = System.currentTimeMillis();
    private boolean dismissed;
    synchronized boolean observe(boolean enabled, String state, String key, long elapsed) {
        if (!enabled || !"recording".equals(state) || key == null || key.isEmpty()) {
            source = ""; dismissed = false; return false;
        }
        if (!source.equals(key) || elapsed < previous || elapsed - previous > MAX_GAP_MS) {
            source = key; first = elapsed; due = first + AFTER_MS; dismissed = false; window++;
        }
        previous = elapsed;
        if (dismissed || elapsed < due) return false;

        // Repeat on a fixed cadence from the first reminder until dismissed.
        while (due <= elapsed) due += REPEAT_MS;
        return true;
    }

    /** Identifies the current observation window; a stale notification carries an older one. */
    synchronized long window() { return source.isEmpty() ? 0 : window; }

    synchronized boolean tracking() { return !source.isEmpty(); }

    /** Swiping or tapping the reminder silences it for the rest of the window it was posted in. */
    synchronized void dismiss(long posted) { if (posted != 0 && posted == window()) dismissed = true; }
}
