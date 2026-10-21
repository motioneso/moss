package ai.moss.vocci;

import android.content.*;
import android.content.pm.PackageManager;
import org.json.JSONObject;

/** Exercises restart routing without rebooting the person's phone or contacting the ring. */
final class RecoveryChecks {
    static void run(Context parent) throws Exception {
        class Capture extends ContextWrapper {
            int starts, permission = PackageManager.PERMISSION_GRANTED;
            boolean refuse;
            Capture() { super(parent); }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return parent.getSharedPreferences("check-" + name, mode); }
            @Override public int checkSelfPermission(String permissionName) { return permission; }
            @Override public ComponentName startForegroundService(Intent service) {
                if (refuse) throw new IllegalStateException("fixture_restriction");
                DeviceChecks.check("recover".equals(service.getAction())); starts++; return new ComponentName(this, DeliveryService.class);
            }
        }
        Capture context = new Capture();
        DeliveryPreferences choices = new DeliveryPreferences(context);
        DeliveryRecovery receiver = new DeliveryRecovery();
        try {
            choices.enabled(false);
            receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
            DeviceChecks.check(context.starts == 0);
            choices.enabled(true);
            context.permission = PackageManager.PERMISSION_DENIED;
            receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
            DeviceChecks.check(context.starts == 0 && !choices.recovery().isEmpty());
            context.permission = PackageManager.PERMISSION_GRANTED;
            new SecretStore(context).save(new JSONObject().put("synthetic", true));
            receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
            receiver.onReceive(context, new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));
            DeviceChecks.check(context.starts == 2 && choices.recovery().isEmpty());
            context.refuse = true;
            receiver.onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
            DeviceChecks.check(context.starts == 2 && choices.enabled() && !choices.recovery().isEmpty());
            choices.enabled(false);
            receiver.onReceive(context, new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));
            receiver.onReceive(context, new Intent("arbitrary"));
            DeviceChecks.check(context.starts == 2 && !new DeliveryPreferences(context).enabled());
            choices.autoCleanup(true); DeviceChecks.check(new DeliveryPreferences(context).autoCleanup());
        } finally {
            new SecretStore(context).delete();
            parent.deleteSharedPreferences("check-delivery-choices");
        }
    }
}
