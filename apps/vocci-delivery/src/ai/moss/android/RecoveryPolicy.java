package ai.moss.android;

/** Decides what the boot and app-update receiver does. Never starts a stopped companion. */
final class RecoveryPolicy {
    enum Step { IGNORE, NEEDS_PERMISSION, START }

    static final String BOOT = "android.intent.action.BOOT_COMPLETED";
    static final String UPDATED = "android.intent.action.MY_PACKAGE_REPLACED";

    private RecoveryPolicy() {}

    static Step choose(String action, boolean wasOn, boolean nearbyPermission) {
        if (!BOOT.equals(action) && !UPDATED.equals(action)) return Step.IGNORE;
        if (!wasOn) return Step.IGNORE;
        return nearbyPermission ? Step.START : Step.NEEDS_PERMISSION;
    }
}
