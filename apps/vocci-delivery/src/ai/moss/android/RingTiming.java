package ai.moss.android;

import android.util.Log;

/** Logcat-only timing marks, in milliseconds since the press end was heard. Never carries content or identifiers. */
final class RingTiming {
    private static final String TAG = "RingTiming";
    private static volatile long origin = System.nanoTime();

    private RingTiming() { }

    static void begin() { origin = System.nanoTime(); }

    /** Wall-clock time of day, so a mark can be compared with when the button was let go. */
    static void clock(String label) {
        Log.i(TAG, label + " at " + new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(new java.util.Date()));
    }

    static void mark(String label) {
        Log.i(TAG, label + " +" + (System.nanoTime() - origin) / 1_000_000L + "ms");
    }
}
