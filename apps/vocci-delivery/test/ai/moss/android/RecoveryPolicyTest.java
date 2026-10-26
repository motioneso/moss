package ai.moss.android;

public final class RecoveryPolicyTest {
    private static void check(boolean ok, String name) { if (!ok) throw new AssertionError(name); }

    public static void main(String[] args) {
        check(RecoveryPolicy.choose(RecoveryPolicy.UPDATED, true, true) == RecoveryPolicy.Step.START, "update restarts delivery that was on");
        check(RecoveryPolicy.choose(RecoveryPolicy.BOOT, true, true) == RecoveryPolicy.Step.START, "boot restarts delivery that was on");
        check(RecoveryPolicy.choose(RecoveryPolicy.UPDATED, false, true) == RecoveryPolicy.Step.IGNORE, "update leaves stopped delivery stopped");
        check(RecoveryPolicy.choose(RecoveryPolicy.UPDATED, true, false) == RecoveryPolicy.Step.NEEDS_PERMISSION, "update without permission asks for it");
        check(RecoveryPolicy.choose("android.intent.action.USER_PRESENT", true, true) == RecoveryPolicy.Step.IGNORE, "other broadcasts are ignored");
        check(RecoveryPolicy.choose(null, true, true) == RecoveryPolicy.Step.IGNORE, "missing action is ignored");
        System.out.println("RecoveryPolicyTest ok");
    }
}
