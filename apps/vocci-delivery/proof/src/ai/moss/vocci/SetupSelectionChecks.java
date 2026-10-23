package ai.moss.vocci;

import android.app.*;
import android.content.Intent;
import android.os.*;
import android.view.*;
import android.widget.*;
import java.io.File;
import java.time.Instant;
import org.json.JSONObject;

/** Installed synthetic UI contract; no vendor request, physical ring or delivery starts. */
public final class SetupSelectionChecks extends Instrumentation {
    private Activity activity;
    private SecretStore stage;
    private boolean created;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            check(getTargetContext().getPackageName().equals("ai.moss.vocci.setupproof"), "isolated_package_required");
            check(new SetupLink(getTargetContext()).status().phase == SetupLink.Phase.EMPTY, "empty_install_required");
            check(!new SecretStore(getTargetContext(), "moss-vocci-account-setup", "vocci-account.enc").exists(), "no_signin_required");
            stage = new SecretStore(getTargetContext(), "moss-vocci-setup", "setup.enc");
            String owner = "00000000-0000-4000-8000-000000000001";
            SetupLink.Port port = new SetupLink.Port() {
                public JSONObject request(String origin, String path, JSONObject body) throws Exception {
                    if (path.equals("/api/companion/pair")) return new JSONObject()
                        .put("attemptId", "00000000-0000-4000-8000-000000000002")
                        .put("approvalPath", "/link/trail-marker#code=" + "b".repeat(32))
                        .put("expiresAt", Instant.now().plusSeconds(600).toString());
                    check(path.equals("/api/companion/pair/redeem"), "only_synthetic_link_requests");
                    return new JSONObject().put("credential", "vr1_" + "A".repeat(43))
                        .put("expiresAt", Instant.now().plusSeconds(86400).toString())
                        .put("account", new JSONObject().put("id", owner).put("name", "Synthetic owner"));
                }
                public String owner(JSONObject configuration) { return owner; }
                public void logout(JSONObject configuration) { throw new AssertionError("moss_link_must_be_retained"); }
            };
            created = true;
            SetupLink link = new SetupLink(stage, new SecretStore(getTargetContext()),
                new File(getTargetContext().getNoBackupFilesDir(), "delivery/state.json"), port,
                binding -> { throw new AssertionError("physical_proof_not_requested"); });
            link.begin("https://moss.example.test"); check(link.check(), "synthetic_moss_link_confirmed");
            link.selectBinding(new JSONObject().put("address", "00:11:22:33:44:55").put("sn", "synthetic-ring-123456")
                .put("deviceId", "synthetic-device").put("bindKey", "synthetic-key"));
            String before = stage.load().getString("credential");
            activity = startActivitySync(new Intent(getTargetContext(), SetupActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitButton("Choose another ring");
            onMain(() -> {
                check(!activity.<EditText>findViewById(3102).isEnabled(), "selected_ring_hides_signin");
                findButton(activity.getWindow().getDecorView(), "Choose another ring").performClick();
            });
            waitButton("Send code");
            check(link.status().phase == SetupLink.Phase.LINKED && !link.status().ringSelected, "back_retains_moss_and_discards_candidate");
            check(before.equals(stage.load().getString("credential")), "moss_credential_retained");
            check(!new SecretStore(getTargetContext()).exists(), "no_configuration_published");
            onMain(() -> {
                check(activity.<EditText>findViewById(3102).isEnabled(), "vocci_lookup_reachable_again");
                check(!findButton(activity.getWindow().getDecorView(), "Verify ring").isEnabled(), "discarded_ring_cannot_verify");
                check(!findButton(activity.getWindow().getDecorView(), "Choose another ring").isShown(), "back_action_hidden_without_candidate");
            });
            result.putString("result", "PASS");
            result.putString("checks", "selected_ring_back_retains_moss_reopens_vocci_without_network_or_commit");
            finish(-1, result);
        } catch (Throwable failure) {
            result.putString("result", "FAIL");
            result.putString("check", failure instanceof AssertionError ? failure.getMessage() : failure.getClass().getSimpleName()); finish(1, result);
        } finally {
            if (activity != null) onMain(() -> activity.finish());
            if (created && stage != null) try { stage.delete(); }
            catch (Exception cleanup) { result.putString("result", "FAIL"); result.putString("check", "synthetic_staging_cleanup_failed"); finish(1, result); }
        }
    }
    private void waitButton(String label) {
        for (int i = 0; i < 80; i++) {
            final boolean[] ready = {false};
            onMain(() -> { Button button = findButton(activity.getWindow().getDecorView(), label); ready[0] = button != null && button.isEnabled(); });
            if (ready[0]) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("control_unavailable_" + label.replace(' ', '_'));
    }
    private void onMain(Runnable action) {
        final Throwable[] failure = {null};
        runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure[0] = error; } });
        if (failure[0] != null) throw new AssertionError(failure[0] instanceof AssertionError ? failure[0].getMessage() : failure[0].getClass().getSimpleName());
    }
    private static Button findButton(View view, String label) {
        if (view instanceof Button && ((Button) view).getText().toString().equals(label)) return (Button) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) { Button found = findButton(group.getChildAt(i), label); if (found != null) return found; }
        }
        return null;
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
