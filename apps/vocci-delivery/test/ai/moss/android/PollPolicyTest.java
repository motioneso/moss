package ai.moss.android;

import java.io.IOException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

public final class PollPolicyTest {
    private static void check(PollPolicy.Next want, Throwable error, int status, int failures, String name) {
        PollPolicy.Next got = PollPolicy.choose(error, status, failures);
        if (got != want) throw new AssertionError(name + ": wanted " + want + " got " + got);
    }

    public static void main(String[] args) {
        check(PollPolicy.Next.RETRY, new SocketTimeoutException(), 0, 1, "timeout");
        check(PollPolicy.Next.RETRY, new UnknownHostException(), 0, 1, "no network");
        check(PollPolicy.Next.RETRY, new IOException("reset"), 0, 5, "dropped connection");
        check(PollPolicy.Next.RETRY, new IOException("server"), 503, 1, "server busy");
        check(PollPolicy.Next.CANCEL, new IOException("declined"), 403, 1, "declined");
        check(PollPolicy.Next.CANCEL, new IOException("gone"), 410, 1, "expired");
        check(PollPolicy.Next.CANCEL, new IllegalStateException("owner_mismatch"), 0, 1, "owner mismatch");
        check(PollPolicy.Next.CANCEL, new IllegalStateException("link_expired"), 0, 1, "expired locally");
        check(PollPolicy.Next.CANCEL, new SocketTimeoutException(), 0, PollPolicy.MAX_FAILURES, "too many failures");
        System.out.println("PollPolicyTest ok");
    }
}
