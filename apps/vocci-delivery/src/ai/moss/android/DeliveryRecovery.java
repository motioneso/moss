package ai.moss.android;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;

/** Boot is delivered after credential storage unlock. Never starts a stopped companion. */
public final class DeliveryRecovery extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) &&
            !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        DeliveryPreferences choices = new DeliveryPreferences(context);
        if (!choices.enabled()) return;
        if (context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            choices.recovery("Grant Nearby devices permission, then Start delivery."); return;
        }
        try {
            new SecretStore(context).load();
            context.startForegroundService(new Intent(context, DeliveryService.class).setAction("recover"));
            choices.recovery("");
        } catch (Exception unavailable) {
            // Android may restrict background starts. Keep the user's choice and evidence.
            choices.recovery("Open the companion and Start delivery to resume after restart.");
        }
    }
}
