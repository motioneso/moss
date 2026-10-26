package ai.moss.android;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.PowerManager;
import java.io.File;
import org.json.JSONObject;

/** Reads the saved setup and phone state, then picks the status card shown on Hardware. */
final class HardwareCard {
    final HomeStatus.Card card;
    final HomeStatus.Setup setup;
    final JSONObject config;
    final boolean delivering;

    private HardwareCard(HomeStatus.Card card, HomeStatus.Setup setup, JSONObject config, boolean delivering) {
        this.card = card; this.setup = setup; this.config = config; this.delivering = delivering;
    }

    static HardwareCard read(Context context) {
        JSONObject config = null;
        // An unreadable saved setup shows recovery and keeps the existing data.
        try { config = new SecretStore(context).load(); } catch (Exception unavailable) { }
        DeliveryPreferences choices = new DeliveryPreferences(context);
        HomeStatus.Setup setup = config != null ? HomeStatus.Setup.READY :
            new SecretStore(context).exists() ? HomeStatus.Setup.UNREADABLE :
            new File(context.getNoBackupFilesDir(), "delivery/state.json").exists() ? HomeStatus.Setup.RECOVERY : HomeStatus.Setup.NEEDED;
        if (setup == HomeStatus.Setup.READY) try { VocciBindings.selected(config); }
        catch (Exception recovery) { setup = HomeStatus.Setup.RECOVERY; }
        boolean permissions = context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        PowerManager power = context.getSystemService(PowerManager.class);
        boolean connected = config != null && config.has("credential");
        if (connected && config.has("credentialExpiresAt")) try {
            connected = java.time.Instant.parse(config.getString("credentialExpiresAt")).isAfter(java.time.Instant.now());
        } catch (Exception invalidExpiry) { connected = false; }
        HomeStatus.Card card = HomeStatus.choose(setup, connected, new MossLink(context).pending(),
            context.getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, DeliveryService.OFFICIAL) == PackageManager.PERMISSION_GRANTED,
            permissions, power == null || !power.isIgnoringBatteryOptimizations(context.getPackageName()), choices.enabled(), choices.recovery());
        return new HardwareCard(card, setup, config, choices.enabled());
    }
}
