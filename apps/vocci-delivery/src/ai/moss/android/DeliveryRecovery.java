package ai.moss.android;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;

/** Restarts delivery after boot or an app update, only if it was on before. */
public final class DeliveryRecovery extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        DeliveryPreferences choices = new DeliveryPreferences(context);
        boolean granted = context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        RecoveryPolicy.Step step = RecoveryPolicy.choose(intent.getAction(), choices.enabled(), granted);
        if (step == RecoveryPolicy.Step.IGNORE) return;
        if (step == RecoveryPolicy.Step.NEEDS_PERMISSION) {
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
