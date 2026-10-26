package ai.moss.android;

import android.app.*;
import android.content.Intent;
import android.os.*;
import android.view.*;
import android.widget.*;
import java.io.File;
import java.util.Arrays;
import org.json.JSONObject;

/** Synthetic ready-screen checks only. Never substitutes for live setup or starts delivery. */
public final class SetupReadyChecks extends Instrumentation {
    private Activity activity;
    private SecretStore config;
    private File journal;
    private boolean ownsFixture;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            check(getTargetContext().getPackageName().equals("ai.moss.android.setupproof"), "isolated_package_required");
            check(new SetupLink(getTargetContext()).status().phase == SetupLink.Phase.EMPTY, "empty_install_required");
            journal = new File(getTargetContext().getNoBackupFilesDir(), "delivery/state.json");
            check(!journal.exists() && !new DeliveryPreferences(getTargetContext()).enabled(), "unused_proof_required");
            config = new SecretStore(getTargetContext()); ownsFixture = true;
            config.save(new JSONObject().put("origin", "https://moss.example.test")
                .put("ownerId", "00000000-0000-4000-8000-000000000001").put("accountName", "Synthetic ready owner")
                .put("credential", "vr1_" + "A".repeat(43)).put("address", "00:11:22:33:44:55")
                .put("sn", "synthetic-ring-123456").put("deviceId", "synthetic-device").put("bindKey", "synthetic-key"));
            byte[] originalConfig = PrivateFiles.read(new File(getTargetContext().getNoBackupFilesDir(), "config.enc"), 16384);
            open();
            onMain(() -> {
                check(button("Start delivery").isEnabled(), "committed_setup_can_start_explicitly");
                Switch hold = activity.findViewById(3105);
                check(!hold.isChecked() && !hold.isEnabled(), "stopped_setup_cannot_enable_hold");
                check(DeliveryActions.command(activity, "voice-on").startsWith("Start delivery before"), "voice_action_does_not_start_stopped_service");
                layout(activity.getWindow().getDecorView());
            });
            check(!journal.exists() && !new DeliveryPreferences(getTargetContext()).enabled(), "opening_ready_does_not_start_delivery");
            onMain(() -> activity.finish()); activity = null;
            JSONObject saved = new JSONObject().put("activity", "waiting_for_completed_recordings")
                .put("voice", new JSONObject().put("desired", true).put("baseline", new JSONObject()));
            PrivateFiles.json(journal, saved); new DeliveryPreferences(getTargetContext()).enabled(true);
            byte[] originalJournal = PrivateFiles.read(journal, 16384);
            open();
            onMain(() -> {
                Switch hold = activity.findViewById(3105);
                check(hold.isChecked() && hold.isEnabled(), "reopening_preserves_existing_hold_choice");
                check(button("Stop delivery").isEnabled(), "enabled_install_can_stop");
                layout(activity.getWindow().getDecorView());
            });
            check(Arrays.equals(originalJournal, PrivateFiles.read(journal, 16384)), "render_does_not_write_voice_journal");
            check(Arrays.equals(originalConfig, PrivateFiles.read(new File(getTargetContext().getNoBackupFilesDir(), "config.enc"), 16384)), "render_preserves_configuration");
            onMain(() -> button("Stop delivery").performClick());
            check(!new DeliveryPreferences(getTargetContext()).enabled(), "explicit_stop_disables_recovery");
            check(Arrays.equals(originalJournal, PrivateFiles.read(journal, 16384)), "stop_keeps_pending_journal");
            result.putString("result", "PASS"); result.putString("checks", "ready_explicit_start_preserved_hold_no_implicit_delivery_stop_recovery_layout");
        } catch (Throwable error) {
            result.putString("result", "FAIL"); result.putString("check", error instanceof AssertionError ? error.getMessage() : error.getClass().getSimpleName());
        } finally {
            if (activity != null) onMain(() -> activity.finish());
            if (ownsFixture) try {
                new DeliveryPreferences(getTargetContext()).enabled(false); config.delete(); new android.util.AtomicFile(journal).delete();
            } catch (Exception error) { result.putString("result", "FAIL"); result.putString("check", "fixture_cleanup"); }
        }
        finish("PASS".equals(result.getString("result")) ? -1 : 1, result);
    }
    private void open() {
        activity = startActivitySync(new Intent(getTargetContext(), SetupActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        for (int i = 0; i < 80; i++) {
            final boolean[] ready = {false};
            onMain(() -> { Button start = find(activity.getWindow().getDecorView(), "Start delivery"); ready[0] = start != null && start.isEnabled(); });
            if (ready[0]) { waitForIdleSync(); return; }
            SystemClock.sleep(100);
        }
        throw new AssertionError("ready_ui_did_not_become_ready");
    }
    private void onMain(Runnable action) {
        final Throwable[] error = {null}; runOnMainSync(() -> { try { action.run(); } catch (Throwable e) { error[0] = e; } });
        if (error[0] != null) throw new AssertionError(error[0] instanceof AssertionError ? error[0].getMessage() : error[0].getClass().getSimpleName());
    }
    private Button button(String label) { Button found = find(activity.getWindow().getDecorView(), label); check(found != null, "button_present"); return found; }
    private static Button find(View view, String label) {
        if (view instanceof Button && ((Button) view).getText().toString().equals(label)) return (Button) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            Button found = find(((ViewGroup) view).getChildAt(i), label); if (found != null) return found;
        }
        return null;
    }
    private void layout(View view) {
        if (!view.isShown()) return;
        if (view instanceof TextView) {
            android.text.Layout text = ((TextView) view).getLayout();
            if (text != null) for (int line = 0; line < text.getLineCount(); line++) check(text.getEllipsisCount(line) == 0, "ready_text_not_ellipsized");
        }
        if (view instanceof Button || view instanceof Switch) check(view.getHeight() >= Math.round(48 * view.getResources().getDisplayMetrics().density), "ready_target_48dp");
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) layout(((ViewGroup) view).getChildAt(i));
    }
    private static void check(boolean value, String name) { if (!value) throw new AssertionError(name); }
}
