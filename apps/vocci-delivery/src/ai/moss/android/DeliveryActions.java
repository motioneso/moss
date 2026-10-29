package ai.moss.android;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;

/** Shared explicit UI commands. Only the service owns delivery and voice journal writes. */
final class DeliveryActions {
    static final String CHANGE_QUEUED = "Change queued";
    static String command(Activity activity, String action) {
        if (!"start".equals(action) && !new DeliveryPreferences(activity).enabled())
            return "Start delivery before changing voice input, clearing audio or retrying.";
        if (!new SecretStore(activity).exists()) return "Finish ring setup before starting delivery.";
        if (activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1);
            return "Allow Nearby devices, then choose the action again.";
        }
        try {
            ComponentName started = activity.startForegroundService(new Intent(activity, DeliveryService.class).setAction(action));
            return started == null ? "Delivery could not start. Reopen the companion and try again." : CHANGE_QUEUED;
        } catch (IllegalStateException | SecurityException unavailable) {
            return "Android could not start delivery. Review permissions and background settings, then try again.";
        }
    }
    static void stop(Context context) {
        new DeliveryPreferences(context).enabled(false);
        context.stopService(new Intent(context, DeliveryService.class));
        RingProblemNotifier.sync(context);
    }
}
