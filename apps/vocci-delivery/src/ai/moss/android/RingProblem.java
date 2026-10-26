package ai.moss.android;

/** Pure policy for the "Ring problems" notification. Never changes delivery. */
final class RingProblem {
    enum Step { POST, CLEAR, KEEP }

    /** True when the card shows a state that stops delivery until the user acts. */
    static boolean blocks(HomeStatus.Card card) {
        switch (card.action) {
            case CONNECT: case VOCCI_SETTINGS: case PERMISSIONS: return true;
            case NONE: return card.title.equals(HomeStatus.UNREADABLE_TITLE);
            default: return false;
        }
    }

    /** The notification text, or null when no notification is due. It matches the card's state line. */
    static String text(HomeStatus.Card card, boolean deliveryEnabled) {
        return deliveryEnabled && blocks(card) ? card.title : null;
    }

    /** Compares the due text with the text already posted, so one state posts once. */
    static Step step(String due, String posted) {
        if (due == null) return posted == null || posted.isEmpty() ? Step.KEEP : Step.CLEAR;
        return due.equals(posted) ? Step.KEEP : Step.POST;
    }
}
