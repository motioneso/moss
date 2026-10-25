package ai.moss.vocci;

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
    }
}
