package ai.moss.android;

import android.app.Instrumentation;
import android.os.Bundle;
import org.json.JSONObject;

/** Development-only diagnosis using the candidate selected through the actual setup UI. */
public final class SetupPhysicalCheck extends Instrumentation {
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            SecretStore staging = new SecretStore(getTargetContext(), "moss-vocci-setup", "setup.enc");
            JSONObject selected = VocciBindings.selected(staging.load().getJSONObject("binding"));
            try (RingConnection connection = new RingConnection(getTargetContext(), selected)) { }
            result.putString("result", "PASS");
            result.putBoolean("configurationPresent", new SecretStore(getTargetContext()).exists());
            finish(-1, result);
        } catch (Exception error) {
            String reason = error.getMessage();
            result.putString("result", "FAIL");
            result.putString("reason", reason != null && reason.matches("ring_(connect|mtu|services|subscribe|identity|challenge|start_app)") ? reason : "physical_check_unavailable");
            finish(1, result);
        }
    }
}
