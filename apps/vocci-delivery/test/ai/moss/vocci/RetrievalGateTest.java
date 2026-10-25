package ai.moss.vocci;

public final class RetrievalGateTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("retrieval gate assertion"); }
    public static void main(String[] args) {
        // Ordinary recordings still need the same sizes on two listings in a row.
        check(!RetrievalGate.ready(false, 10, 40, null, null));
        check(!RetrievalGate.ready(false, 10, 40, 10, null));
        check(!RetrievalGate.ready(false, 10, 40, 10, 41));
        check(RetrievalGate.ready(false, 10, 40, 10, 40));
        // Hold-to-talk recordings may be fetched on first sighting; the completed-sidecar check still gates audio.
        check(RetrievalGate.ready(true, 10, 40, null, null));
        check(RetrievalGate.ready(true, 10, 40, 9, 39));
        // A missing sidecar is never ready.
        check(!RetrievalGate.ready(true, null, 40, null, null));
        check(!RetrievalGate.ready(false, null, 40, 10, 40));
        System.out.println("PASS: first-sighting retrieval only for hold-to-talk recordings, two stable listings otherwise");
    }
}
