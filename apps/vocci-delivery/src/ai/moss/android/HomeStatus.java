package ai.moss.android;

/** Pure presentation policy. Blockers outrank delivering/stopped, never change delivery. */
final class HomeStatus {
    enum Setup { READY, NEEDED, RECOVERY, UNREADABLE }
    enum Action { NONE, SETUP, CONNECT, APPROVAL, VOCCI_SETTINGS, PERMISSIONS, APP_SETTINGS, START, STOP }
    static final String UNREADABLE_TITLE = "Setup could not be opened";
    static final class Card {
        final String title, label;
        final Action action;
        final boolean primary, cancel;
        Card(String title, String label, Action action, boolean primary, boolean cancel) {
            this.title = title; this.label = label; this.action = action; this.primary = primary; this.cancel = cancel;
        }
    }
    static Card choose(Setup setup, boolean connected, boolean pending, boolean officialAccess,
                       boolean permissions, boolean batteryRestricted, boolean delivering, String recovery) {
        // An unreadable saved configuration must never offer a command using partial data.
        if (setup == Setup.UNREADABLE) return card(UNREADABLE_TITLE, "", Action.NONE, false);
        if (setup != Setup.READY) return card("Set up your ring", "Set up ring", Action.SETUP, true);
        if (pending) return new Card("Waiting for approval in browser", "Reopen browser approval", Action.APPROVAL, true, true);
        if (!connected) return card("Moss account not connected", "Connect Moss in browser", Action.CONNECT, true);
        if (officialAccess) return card("Can't reach the ring", "Open Vocci app settings", Action.VOCCI_SETTINGS, true);
        if (!permissions) return card("Permission needed", "Allow Bluetooth and notifications", Action.PERMISSIONS, true);
        if (delivering && batteryRestricted) return card("Delivering, may pause in background", "Open app settings", Action.APP_SETTINGS, true);
        if (recovery != null && !recovery.isEmpty()) return card(recovery, delivering ? "" : "Start delivery", delivering ? Action.NONE : Action.START, !delivering);
        return delivering ? card("Delivering", "Stop delivery", Action.STOP, false) : card("Stopped", "Start delivery", Action.START, true);
    }
    private static Card card(String title, String label, Action action, boolean primary) {
        return new Card(title, label, action, primary, false);
    }
}
