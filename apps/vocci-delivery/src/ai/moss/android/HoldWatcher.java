package ai.moss.android;

/**
 * Spots the end of a hold-to-talk press. While the button is held the ring streams a message about every 120 ms,
 * so the stream going quiet is the release. A hold state followed by idle is also a release, reported once.
 */
final class HoldWatcher {
    static final int STREAM = 0x26;
    private static final int STREAM_MIN = 5;
    private static final long QUIET_MS = 400;
    private boolean held;
    private int streamed;
    private long lastStream;

    boolean accept(int command, byte[] payload) { return accept(command, payload, System.currentTimeMillis()); }

    /** Returns true once, when the press ends. */
    boolean accept(int command, byte[] payload, long nowMs) {
        if (command == STREAM) { streamed++; lastStream = nowMs; return false; }
        if (command != RingTelemetry.RECORDING) return false;
        String state;
        try { state = RingTelemetry.recording(payload); } catch (IllegalArgumentException invalid) { return false; }
        if (state.equals("hold")) { held = true; return false; }
        if (held && state.equals("idle")) { held = false; streamed = 0; return true; }
        return false;
    }

    /** Returns true once, when a long enough stream has been silent for a moment. */
    boolean quiet(long nowMs) {
        if (streamed < STREAM_MIN || nowMs - lastStream < QUIET_MS) return false;
        streamed = 0; held = false;
        return true;
    }
}
