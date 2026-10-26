package ai.moss.vocci;

public final class HomeStatusTest {
    private static int assertions;
    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Home status assertion " + assertions); }
    private static HomeStatus.Card card(HomeStatus.Setup setup, int flags, String recovery) {
        return HomeStatus.choose(setup, (flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0,
            (flags & 8) != 0, (flags & 16) != 0, (flags & 32) != 0, recovery);
    }
    public static void main(String[] args) {
        // Every combination: setup, approval/account, competing app, permissions, battery, recovery.
        for (HomeStatus.Setup setup : HomeStatus.Setup.values()) for (int flags = 0; flags < 64; flags++) {
            for (String recovery : new String[]{"", "Reconnect to resume"}) {
                HomeStatus.Card actual = card(setup, flags, recovery);
                boolean connected = (flags & 1) != 0, pending = (flags & 2) != 0;
                boolean official = (flags & 4) != 0, permissions = (flags & 8) != 0;
                boolean battery = (flags & 16) != 0, running = (flags & 32) != 0;
                HomeStatus.Action expected;
                if (setup == HomeStatus.Setup.UNREADABLE) expected = HomeStatus.Action.NONE;
                else if (setup != HomeStatus.Setup.READY) expected = HomeStatus.Action.SETUP;
                else if (pending) expected = HomeStatus.Action.APPROVAL;
                else if (!connected) expected = HomeStatus.Action.CONNECT;
                else if (official) expected = HomeStatus.Action.VOCCI_SETTINGS;
                else if (!permissions) expected = HomeStatus.Action.PERMISSIONS;
                else if (running && battery) expected = HomeStatus.Action.APP_SETTINGS;
                else if (running && !recovery.isEmpty()) expected = HomeStatus.Action.NONE;
                else expected = running ? HomeStatus.Action.STOP : HomeStatus.Action.START;
                check(actual.action == expected);
                check(actual.cancel == (expected == HomeStatus.Action.APPROVAL));
                check(actual.primary == (expected != HomeStatus.Action.NONE && expected != HomeStatus.Action.STOP));
                check(actual.label.isEmpty() == (expected == HomeStatus.Action.NONE));
            }
        }
        HomeStatus.Card running = card(HomeStatus.Setup.READY, 1 | 8 | 32, "");
        check(running.title.equals("Delivering") && running.label.equals("Stop delivery"));
        HomeStatus.Card stopped = card(HomeStatus.Setup.READY, 1 | 8 | 16, "");
        check(stopped.title.equals("Stopped") && stopped.label.equals("Start delivery"));
        check(card(HomeStatus.Setup.READY, 1 | 8, "Restore original account").title.equals("Restore original account"));
        check(card(HomeStatus.Setup.READY, 8, "").title.equals("Moss account not connected")); // developer sessions count as disconnected
        check(HomeStatus.choose(HomeStatus.Setup.READY, true, false, false, true, false, false, null).action == HomeStatus.Action.START);
        System.out.println("PASS: Home status action, 512 state combinations, " + assertions + " assertions");
    }
}
