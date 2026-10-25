package ai.moss.vocci;

/** Spots the end of a hold-to-talk press from the ring's own recording-state messages. */
final class HoldWatcher {
    private boolean held;

    /** Returns true once, when the ring goes from hold back to idle. */
    boolean accept(int command, byte[] payload) {
        if (command != RingTelemetry.RECORDING) return false;
        String state;
        try { state = RingTelemetry.recording(payload); } catch (IllegalArgumentException invalid) { return false; }
        if (state.equals("hold")) { held = true; return false; }
        if (held && state.equals("idle")) { held = false; return true; }
        return false;
    }
}
