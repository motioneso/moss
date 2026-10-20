package ai.moss.vocci;

final class RetryPolicy {
    static final int MAX_ATTEMPTS = 8;
    static long delayMs(int attempts) {
        if (attempts < 1 || attempts > MAX_ATTEMPTS) throw new IllegalArgumentException("attempts");
        return Math.min(30_000L << (attempts - 1), 30 * 60_000L);
    }
    static boolean due(int attempts, long nextAt, long now) {
        return attempts < MAX_ATTEMPTS && now >= nextAt;
    }
}
