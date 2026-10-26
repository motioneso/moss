package ai.moss.vocci;

public final class RecordingReminderTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("reminder assertion"); }
    private static final long A = RecordingReminder.AFTER_MS, R = RecordingReminder.REPEAT_MS;
    private static int count(RecordingReminder policy, String key, long from, long to) {
        int fired = 0;
        for (long t = from; t <= to; t += 30000) if (policy.observe(true, "recording", key, t)) fired++;
        return fired;
    }
    public static void main(String[] args) {
        RecordingReminder policy = new RecordingReminder();
        for (long t = 0; t < A; t += 30000) check(!policy.observe(true, "recording", "first", t));
        check(policy.observe(true, "recording", "first", A));
        check(!policy.observe(true, "recording", "first", A + 30000));

        // Repeats every half hour after the first hour while undismissed.
        check(count(policy, "first", A + 60000, A + R - 30000) == 0);
        check(policy.observe(true, "recording", "first", A + R));
        check(count(policy, "first", A + R + 30000, A + 3 * R) == 2);

        // Dismissal silences the rest of this recording only.
        policy.dismiss();
        check(count(policy, "first", A + 3 * R + 30000, A + 6 * R) == 0);
        check(!policy.observe(true, "recording", "second", A + 6 * R + 30000));
        check(count(policy, "second", A + 6 * R + 60000, 2 * A + 6 * R + 30000) == 1);

        // Hold, unknown, disabled and missing source reset the window and any dismissal.
        check(!policy.observe(true, "hold", "second", 3 * A));
        check(!policy.observe(false, "recording", "second", 3 * A + 30000));
        check(!policy.observe(true, "recording", "", 3 * A + 60000));
        check(!policy.observe(true, "unknown", "second", 3 * A + 90000));

        // A large gap or backwards monotonic clock starts a new observation window.
        RecordingReminder clock = new RecordingReminder();
        check(count(clock, "third", 0, A) == 1);
        clock.dismiss();
        check(!clock.observe(true, "recording", "third", 4 * A));
        check(!clock.observe(true, "recording", "third", 0));
        for (long t = 30000; t < A; t += 30000) check(!clock.observe(true, "recording", "third", t));
        check(clock.observe(true, "recording", "third", A));

        // Dismissing with no observed recording does not pre-silence the next one.
        RecordingReminder idle = new RecordingReminder();
        idle.dismiss();
        check(count(idle, "fourth", 0, A) == 1);
        System.out.println("PASS: opt-in recording reminder, repeats until dismissed, gap/hold/unknown/restart resets");
    }
}
