package ai.moss.vocci;

public final class RecordingReminderTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("reminder assertion"); }
    public static void main(String[] args) {
        RecordingReminder policy = new RecordingReminder();
        for (long t = 0; t < RecordingReminder.AFTER_MS; t += 30000) check(!policy.observe(true, "recording", "first", t));
        check(policy.observe(true, "recording", "first", RecordingReminder.AFTER_MS));
        check(!policy.observe(true, "recording", "first", RecordingReminder.AFTER_MS + 30000));
        check(!policy.observe(true, "recording", "second", RecordingReminder.AFTER_MS + 60000));
        check(!policy.observe(true, "hold", "second", RecordingReminder.AFTER_MS + 90000));
        check(!policy.observe(false, "recording", "second", RecordingReminder.AFTER_MS + 120000));
        check(!policy.observe(true, "recording", "", RecordingReminder.AFTER_MS * 2));
        check(!policy.observe(true, "recording", "second", RecordingReminder.AFTER_MS * 3));
        // A large gap or backwards monotonic clock starts a new observation window.
        check(!policy.observe(true, "recording", "second", RecordingReminder.AFTER_MS * 4));
        check(!policy.observe(true, "recording", "second", 0));
        for (long t = 30000; t < RecordingReminder.AFTER_MS; t += 30000) check(!policy.observe(true, "recording", "second", t));
        check(policy.observe(true, "recording", "second", RecordingReminder.AFTER_MS));
        check(!policy.observe(true, "unknown", "second", RecordingReminder.AFTER_MS + 30000));
        check(!policy.observe(true, "recording", "second", RecordingReminder.AFTER_MS + 60000));
        System.out.println("PASS: opt-in recording reminder, once per observed source, gap/hold/unknown/restart resets");
    }
}
