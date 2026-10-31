package ai.moss.android;

final class RetryPolicy {
    static final int MAX_ATTEMPTS = 8;
    static long delayMs(int attempts) {
        if (attempts < 1 || attempts > MAX_ATTEMPTS) throw new IllegalArgumentException("attempts");
        return Math.min(30_000L << (attempts - 1), 30 * 60_000L);
    }
    static int connectionFailure(int failures) { return Math.min(failures + 1, MAX_ATTEMPTS); }
    static long connectionDelayMs(int failures) { return failures == 0 ? 30000 : delayMs(failures); }
    /** Hold-to-talk waits for a press, so the first failed cycle retries soon; repeated failures back off as usual. */
    static long holdFailureDelayMs(int failures) { return failures == 1 ? 2000 : connectionDelayMs(failures); }
    static boolean due(int attempts, long nextAt, long now) {
        return attempts < MAX_ATTEMPTS && now >= nextAt;
    }
}
