package ai.moss.android;

import java.io.IOException;

/** Decides whether a failed approval check is worth another try. */
final class PollPolicy {
    enum Next { RETRY, CANCEL }

    /** About a minute of unbroken failures at the three second poll. */
    static final int MAX_FAILURES = 20;

    private PollPolicy() {}

    /** The status is the HTTP status of a rejected request, or 0 when the failure had none. */
    static Next choose(Throwable error, int httpStatus, int consecutiveFailures) {
        if (consecutiveFailures >= MAX_FAILURES) return Next.CANCEL;
        if (httpStatus >= 500 && httpStatus < 600) return Next.RETRY;
        if (httpStatus != 0) return Next.CANCEL;
        return error instanceof IOException ? Next.RETRY : Next.CANCEL;
    }
}
