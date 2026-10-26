package ai.moss.android;

import android.app.*;
import android.content.Intent;
import android.os.*;
import android.widget.*;
import java.io.File;

/** Exercises the production empty-install UI; refuses configured or staged installs. */
public final class SetupUiChecks extends Instrumentation {
    private Activity activity;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            check(new SetupLink(getTargetContext()).status().phase == SetupLink.Phase.EMPTY, "empty_install_required");
            activity = startActivitySync(new Intent(getTargetContext(), SetupActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitReady();
            waitForIdleSync();
            final EditText[] address = new EditText[1], email = new EditText[1];
            onMain(() -> {
                address[0] = activity.findViewById(3101); email[0] = activity.findViewById(3102);
                check(address[0].isEnabled() && !email[0].isEnabled(), "moss_precedes_vocci");
                checkLayout(activity.getWindow().getDecorView());
                address[0].setText("not-an-origin");
                findButton(activity.getWindow().getDecorView(), "Connect Moss in browser").performClick();
            });
            waitReady();
            waitForIdleSync();
            onMain(() -> {
                check(activity.findViewById(3101) == address[0] && activity.findViewById(3102) == email[0], "fields_remain_mounted_after_error");
                check(address[0].getText().toString().equals("not-an-origin"), "invalid_origin_preserved_for_correction");
                check(((TextView) activity.findViewById(3104)).getText().toString().contains("complete HTTPS Moss address"), "origin_error_actionable");
                check(!email[0].isEnabled(), "invalid_moss_cannot_send_vocci_code");
                checkLayout(activity.getWindow().getDecorView());
            });
            check(new SetupLink(getTargetContext()).status().phase == SetupLink.Phase.EMPTY, "invalid_origin_leaves_no_staging");
            check(!new SecretStore(getTargetContext(), "moss-vocci-account-setup", "vocci-account.enc").exists(), "opening_setup_does_not_start_signin");
            check(!new File(getTargetContext().getNoBackupFilesDir(), "delivery/state.json").exists(), "opening_setup_does_not_create_queue");
            result.putString("result", "PASS"); result.putString("checks", "production_empty_ui_invalid_origin_stable_fields_no_delivery"); finish(-1, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL"); result.putString("check", error instanceof AssertionError ? error.getMessage() : error.getClass().getSimpleName()); finish(1, result);
        } finally { if (activity != null) onMain(() -> activity.finish()); }
    }
    private void waitReady() {
        for (int i = 0; i < 80; i++) {
            final boolean[] ready = {false};
            onMain(() -> ready[0] = activity.<EditText>findViewById(3101).isEnabled());
            if (ready[0]) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("setup_ui_did_not_become_ready");
    }
    private void onMain(Runnable action) {
        final Throwable[] failure = {null};
        runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure[0] = error; } });
        if (failure[0] != null) throw new AssertionError(failure[0] instanceof AssertionError ? failure[0].getMessage() : failure[0].getClass().getSimpleName());
    }
    private void checkLayout(android.view.View view) {
        if (!view.isShown()) return;
        if (view instanceof TextView) {
            android.text.Layout layout = ((TextView) view).getLayout();
            if (layout != null) for (int line = 0; line < layout.getLineCount(); line++) check(layout.getEllipsisCount(line) == 0, "setup_text_must_not_be_ellipsized");
        }
        if (view instanceof Button) check(view.getHeight() >= Math.round(48 * view.getResources().getDisplayMetrics().density), "setup_button_target_48dp");
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) checkLayout(group.getChildAt(i));
        }
    }
    private static Button findButton(android.view.View root, String text) {
        if (root instanceof Button && ((Button) root).getText().toString().equals(text)) return (Button) root;
        if (root instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) { Button found = findButton(group.getChildAt(i), text); if (found != null) return found; }
        }
        return null;
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
