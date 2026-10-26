package ai.moss.android;

public final class RingProblemTest {
    private static int assertions;
    private static final int ACCOUNT = 1, PENDING = 2, VOCCI = 4, PERMISSIONS = 8, RESTRICTED = 16, RUNNING = 32;
    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("Ring problem assertion " + assertions); }
    private static HomeStatus.Card card(HomeStatus.Setup setup, int flags) {
        return HomeStatus.choose(setup, (flags & ACCOUNT) != 0, (flags & PENDING) != 0, (flags & VOCCI) != 0,
            (flags & PERMISSIONS) != 0, (flags & RESTRICTED) != 0, (flags & RUNNING) != 0, "");
    }
    public static void main(String[] args) {
        // The four blocking states, with delivery on, carry the card's own state line.
        check("Moss account not connected".equals(RingProblem.text(card(HomeStatus.Setup.READY, PERMISSIONS), true)));
        check("Can't reach the ring".equals(RingProblem.text(card(HomeStatus.Setup.READY, ACCOUNT | VOCCI | PERMISSIONS), true)));
        check("Permission needed".equals(RingProblem.text(card(HomeStatus.Setup.READY, ACCOUNT), true)));
        check("Setup could not be opened".equals(RingProblem.text(card(HomeStatus.Setup.UNREADABLE, ACCOUNT | PERMISSIONS), true)));

        // Delivery off means no notification, whatever the card shows.
        check(RingProblem.text(card(HomeStatus.Setup.READY, PERMISSIONS), false) == null);
        check(RingProblem.text(card(HomeStatus.Setup.UNREADABLE, 0), false) == null);

        // Healthy, setup-needed and waiting states do not notify.
        check(RingProblem.text(card(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS | RUNNING), true) == null);
        check(RingProblem.text(card(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS), true) == null);
        check(RingProblem.text(card(HomeStatus.Setup.READY, ACCOUNT | PERMISSIONS | RESTRICTED | RUNNING), true) == null);
        check(RingProblem.text(card(HomeStatus.Setup.NEEDED, 0), true) == null);
        check(RingProblem.text(card(HomeStatus.Setup.READY, PENDING | PERMISSIONS), true) == null);

        // Every state combination agrees with the blocking set.
        for (HomeStatus.Setup setup : HomeStatus.Setup.values()) for (int flags = 0; flags < 64; flags++) {
            HomeStatus.Card actual = card(setup, flags);
            String due = RingProblem.text(actual, true);
            check((due != null) == RingProblem.blocks(actual));
            if (due != null) check(due.equals(actual.title) && !actual.primary == (actual.action == HomeStatus.Action.NONE));
        }

        // One state posts once, clears when it resolves, and reposts when it changes.
        check(RingProblem.step("Permission needed", null) == RingProblem.Step.POST);
        check(RingProblem.step("Permission needed", "") == RingProblem.Step.POST);
        check(RingProblem.step("Permission needed", "Permission needed") == RingProblem.Step.KEEP);
        check(RingProblem.step("Can't reach the ring", "Permission needed") == RingProblem.Step.POST);
        check(RingProblem.step(null, "Permission needed") == RingProblem.Step.CLEAR);
        check(RingProblem.step(null, null) == RingProblem.Step.KEEP);
        check(RingProblem.step(null, "") == RingProblem.Step.KEEP);
        System.out.println("PASS: Ring problem policy, " + assertions + " assertions");
    }
}
