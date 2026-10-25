package ai.moss.vocci;

/** Decides whether a listed recording may be fetched this cycle. */
final class RetrievalGate {
    private RetrievalGate() {}

    /**
     * Recordings with a fresh voice-request intent are short, so the sidecar is fetched on first sighting; the completed
     * sidecar check and the announced transfer size still keep a growing file from being delivered.
     * Every other recording needs identical packet and sidecar sizes on two listings in a row.
     */
    static boolean ready(boolean hold, Integer sidecarSize, Integer packetSize, Integer previousSidecarSize, Integer previousPacketSize) {
        if (sidecarSize == null || packetSize == null) return false;
        if (hold) return true;
        return packetSize.equals(previousPacketSize) && sidecarSize.equals(previousSidecarSize);
    }
}
