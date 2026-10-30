package ai.moss.android;

public final class HoldWatcherTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("hold watcher assertion"); }
    private static byte[] state(int code) { return new byte[]{(byte) code, 2, 'a', 'b'}; }
    public static void main(String[] args) {
        HoldWatcher watcher = new HoldWatcher();
        // Idle alone, or other messages, never signal a release.
        check(!watcher.accept(0x13, state(16)));
        check(!watcher.accept(0x38, new byte[5]));
        // A hold followed by idle is a release, reported once.
        check(!watcher.accept(0x13, state(17)));
        check(!watcher.accept(0x13, state(17)));
        check(watcher.accept(0x13, state(16)));
        check(!watcher.accept(0x13, state(16)));
        // A normal recording ending is not a hold release.
        check(!watcher.accept(0x13, state(1)));
        check(!watcher.accept(0x13, state(0)));
        // Malformed state messages are ignored and keep the pending hold.
        check(!watcher.accept(0x13, state(17)));
        check(!watcher.accept(0x13, new byte[0]));
        check(watcher.accept(0x13, state(0)));
        // The ring streams 0x26 messages about every 120 ms while the button is held. The end of the stream is the release.
        HoldWatcher stream = new HoldWatcher();
        for (int n = 0; n < 20; n++) check(!stream.accept(0x26, new byte[4], 1000 + n * 120L));
        check(!stream.quiet(1000 + 19 * 120L + 300));
        check(stream.quiet(1000 + 19 * 120L + 450));
        check(!stream.quiet(1000 + 19 * 120L + 900));
        // A short burst is not a hold, and a stream with no end yet never reports a release.
        HoldWatcher brief = new HoldWatcher();
        for (int n = 0; n < 2; n++) check(!brief.accept(0x26, new byte[4], 5000 + n * 120L));
        check(!brief.quiet(9000));
        HoldWatcher live = new HoldWatcher();
        for (int n = 0; n < 10; n++) check(!live.accept(0x26, new byte[4], 100 + n * 120L));
        check(!live.quiet(100 + 9 * 120L + 100));
        // The later idle message after a stream end does not report a second release.
        HoldWatcher once = new HoldWatcher();
        for (int n = 0; n < 6; n++) once.accept(0x26, new byte[4], n * 120L);
        check(once.quiet(2000));
        check(!once.accept(0x13, state(16), 3000));
    }
}
