package ai.moss.android;

import java.util.ArrayList;
import java.util.List;

public final class LinkSpeedTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("link speed assertion"); }
    public static void main(String[] args) {
        List<Integer> asked = new ArrayList<>();
        boolean[] accept = {true};
        LinkSpeed speed = new LinkSpeed(priority -> { asked.add(priority); return accept[0]; });

        // Connecting and handling a press use the fast setting.
        speed.fast();
        check(asked.equals(List.of(LinkSpeed.HIGH)));

        // Waiting for the next press switches back to normal speed, once.
        speed.waiting();
        speed.waiting();
        check(asked.equals(List.of(LinkSpeed.HIGH, LinkSpeed.BALANCED)));

        // A press makes it fast again, and the next wait releases it again.
        speed.fast();
        speed.fast();
        speed.waiting();
        check(asked.equals(List.of(LinkSpeed.HIGH, LinkSpeed.BALANCED, LinkSpeed.HIGH, LinkSpeed.BALANCED)));

        // A refused switch back is retried on the next wait, so the link never stays fast by accident.
        speed.fast();
        accept[0] = false;
        speed.waiting();
        accept[0] = true;
        speed.waiting();
        speed.waiting();
        check(asked.subList(4, asked.size()).equals(List.of(LinkSpeed.HIGH, LinkSpeed.BALANCED, LinkSpeed.BALANCED)));

        // A refused fast request is not treated as fast, so waiting asks for nothing.
        LinkSpeed refused = new LinkSpeed(priority -> { asked.add(priority); return false; });
        int before = asked.size();
        refused.fast();
        refused.waiting();
        check(asked.size() == before + 1);

        // Values match Android's connection priority constants.
        check(LinkSpeed.BALANCED == 0 && LinkSpeed.HIGH == 1);
    }
}
