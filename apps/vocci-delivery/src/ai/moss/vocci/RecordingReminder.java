package ai.moss.vocci;

/** Conservative observation window, not a guessed capture duration. No recording controls. */
final class RecordingReminder {
    static final long AFTER_MS = 60 * 60 * 1000L, MAX_GAP_MS = 2 * 60 * 1000L;
    private String source = "";
    private long first, previous;
    private boolean sent;
    boolean observe(boolean enabled, String state, String key, long elapsed) {
        if (!enabled || !"recording".equals(state) || key == null || key.isEmpty()) {
            source = ""; sent = false; return false;
        }
        if (!source.equals(key) || elapsed < previous || elapsed - previous > MAX_GAP_MS) {
            source = key; first = elapsed; sent = false;
        }
        previous = elapsed;
        if (!sent && elapsed - first >= AFTER_MS) { sent = true; return true; }
        return false;
    }
}
