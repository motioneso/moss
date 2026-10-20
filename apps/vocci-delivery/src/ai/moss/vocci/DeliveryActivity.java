package ai.moss.vocci;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;

/** Developer launch entry; feedback is the foreground service's deterministic notification. */
public final class DeliveryActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if ("stop".equals(getIntent().getAction())) { stopService(new Intent(this, DeliveryService.class)); finish(); return; }
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1);
        } else launch();
    }
    private void launch() { startForegroundService(new Intent(this, DeliveryService.class)); finish(); }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) launch(); else finish();
    }
}
