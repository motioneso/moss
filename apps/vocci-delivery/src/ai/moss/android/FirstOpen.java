package ai.moss.android;

/** Picks the launcher's first screen from the saved Moss link. Plain function, host tested. */
final class FirstOpen {
    enum Link { NONE, APPROVING, LINKED, BROKEN }
    enum Screen { CONNECT, MOSS, HARDWARE }

    private FirstOpen() { }

    static Screen choose(Link link) {
        switch (link) {
            case NONE: case APPROVING: return Screen.CONNECT;
            case LINKED: return Screen.MOSS;
            default: return Screen.HARDWARE;
        }
    }

    /** True when ring setup can skip the Moss step and start at the Vocci account. */
    static boolean skipsMossStep(Link link) { return link == Link.LINKED; }
}
