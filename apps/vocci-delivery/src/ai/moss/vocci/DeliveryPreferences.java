package ai.moss.vocci;

import android.content.Context;
import android.content.SharedPreferences;

/** User choices are independent of the single-worker delivery journal. */
final class DeliveryPreferences {
    private final SharedPreferences values;
    DeliveryPreferences(Context context) { values = context.getSharedPreferences("delivery-choices", Context.MODE_PRIVATE); }
    boolean enabled() { return values.getBoolean("enabled", false); }
    void enabled(boolean enabled) { values.edit().putBoolean("enabled", enabled).putString("recovery", "").commit(); }
    boolean applyAction(String action) {
        if ("start".equals(action)) enabled(true);
        else if ("stop".equals(action)) enabled(false);
        return enabled();
    }
    boolean autoCleanup() { return values.getBoolean("autoCleanup", false); }
    void autoCleanup(boolean enabled) { values.edit().putBoolean("autoCleanup", enabled).commit(); }
    boolean recordingReminder() { return values.getBoolean("recordingReminder", false); }
    void recordingReminder(boolean enabled) { values.edit().putBoolean("recordingReminder", enabled).commit(); }
    String recovery() { return values.getString("recovery", ""); }
    void recovery(String reason) { values.edit().putString("recovery", reason).commit(); }
}
