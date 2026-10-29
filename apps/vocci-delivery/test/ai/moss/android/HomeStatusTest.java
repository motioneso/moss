package ai.moss.android;

public final class HomeStatusTest {
    private static int assertions;
    private static final int ACCOUNT = 1, PENDING = 2, VOCCI = 4, PERMISSIONS = 8, RESTRICTED = 16, RUNNING = 32;
    private static final int ALL = ACCOUNT | PENDING | VOCCI | PERMISSIONS | RESTRICTED | RUNNING;
    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Home status assertion " + assertions); }
    private static HomeStatus.Card card(HomeStatus.Setup setup, int flags, String recovery) {
        return HomeStatus.choose(setup, (flags & ACCOUNT) != 0, (flags & PENDING) != 0, (flags & VOCCI) != 0,
            (flags & PERMISSIONS) != 0, (flags & RESTRICTED) != 0, (flags & RUNNING) != 0, recovery);
    }
    private static void expect(HomeStatus.Setup setup, int flags, String recovery, String title, String label, HomeStatus.Action action) {
        HomeStatus.Card actual = card(setup, flags, recovery);
        if (!actual.title.equals(title) || !actual.label.equals(label) || actual.action != action)
            throw new AssertionError(title + ": got " + actual.title + " / " + actual.label + " / " + actual.action);
        assertions++;
    }
    public static void main(String[] args) {
        // Spec examples, including collisions: the blocking fix wins over Start/Stop.
        expect(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS | RUNNING, "", "Delivering", "Stop delivery", HomeStatus.Action.STOP);
        expect(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS | RESTRICTED, "", "Stopped", "Start delivery", HomeStatus.Action.START);
        expect(HomeStatus.Setup.NEEDED, ALL, "", "Set up your ring", "Set up ring", HomeStatus.Action.SETUP);
        expect(HomeStatus.Setup.RECOVERY, ALL, "", "Set up your ring", "Set up ring", HomeStatus.Action.SETUP);
        expect(HomeStatus.Setup.UNREADABLE, ALL, "Recover", "Setup could not be opened", "", HomeStatus.Action.NONE);
        expect(HomeStatus.Setup.READY, VOCCI | PERMISSIONS | RESTRICTED | RUNNING, "", "Moss account not connected", "Connect Moss in browser", HomeStatus.Action.CONNECT);
        expect(HomeStatus.Setup.READY, PENDING | VOCCI | PERMISSIONS | RESTRICTED | RUNNING, "", "Waiting for approval in browser", "Reopen browser approval", HomeStatus.Action.APPROVAL);
        expect(HomeStatus.Setup.READY, ALL, "", "Waiting for approval in browser", "Reopen browser approval", HomeStatus.Action.APPROVAL);
        expect(HomeStatus.Setup.READY, ACCOUNT | VOCCI | RESTRICTED | RUNNING, "", "Can't reach the ring", "Open Vocci app settings", HomeStatus.Action.VOCCI_SETTINGS);
        expect(HomeStatus.Setup.READY, ACCOUNT | RESTRICTED | RUNNING, "Recover", "Permission needed", "Allow Bluetooth and notifications", HomeStatus.Action.PERMISSIONS);
        expect(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS | RESTRICTED | RUNNING, "Recover", "Delivering, may pause in background", "Open app settings", HomeStatus.Action.APP_SETTINGS);
        expect(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS, "Restore original account", "Restore original account", "Start delivery", HomeStatus.Action.START);
        expect(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS | RUNNING, "Restore original account", "Restore original account", "", HomeStatus.Action.NONE);
        // Developer-session credentials are not a connected account.
        expect(HomeStatus.Setup.READY, PERMISSIONS, "", "Moss account not connected", "Connect Moss in browser", HomeStatus.Action.CONNECT);
        check(HomeStatus.choose(HomeStatus.Setup.READY, true, false, false, true, false, false, null).action == HomeStatus.Action.START);

        // Rendering contract across every input combination, independent of priority ordering.
        for (HomeStatus.Setup setup : HomeStatus.Setup.values()) for (int flags = 0; flags < 64; flags++) {
            for (String recovery : new String[]{"", "Reconnect to resume"}) {
                HomeStatus.Card actual = card(setup, flags, recovery);
                check(!actual.title.isEmpty());
                check(actual.label.isEmpty() == (actual.action == HomeStatus.Action.NONE));
                check(actual.cancel == (actual.action == HomeStatus.Action.APPROVAL));
                check(actual.primary == (actual.action != HomeStatus.Action.NONE && actual.action != HomeStatus.Action.STOP));
                if (setup == HomeStatus.Setup.UNREADABLE) check(actual.action == HomeStatus.Action.NONE);
                if (actual.action == HomeStatus.Action.STOP) check((flags & RUNNING) != 0);
                if (actual.action == HomeStatus.Action.START) check((flags & RUNNING) == 0);
            }
        }
        System.out.println("PASS: Home status spec/precedence cases and 512 state combinations, " + assertions + " assertions");
    }
}
