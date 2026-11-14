package ai.moss.android;

/**
 * Holds the ring link at the fast connection setting only while work is happening. The link stays open all day with
 * hold-to-talk on, and the fast setting drains the ring battery, so every return to waiting asks for normal speed.
 */
final class LinkSpeed {

    /** Android's BluetoothGatt.CONNECTION_PRIORITY_BALANCED and CONNECTION_PRIORITY_HIGH. */
    static final int BALANCED = 0, HIGH = 1;

    interface Radio { boolean request(int priority); }

    private final Radio radio;
    private boolean fast;

    LinkSpeed(Radio radio) { this.radio = radio; }

    void fast() { if (!fast) fast = radio.request(HIGH); }

    /** Called on every wait step; a refused request stays pending and is retried on the next call. */
    void waiting() { if (fast) fast = !radio.request(BALANCED); }
}
