package ai.moss.vocci;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import java.io.File;
import java.time.Instant;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Isolated first-install browser-link proof. No ring permissions or delivery service. */
public final class MossSetupProofActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private NativeTheme theme;
    private SetupLink link;
    private SetupLink.Status snapshot;
    private EditText address;
    private TextView status, account;
    private Button connect, check, cancel;
    private boolean busy = true;
    @Override public void onCreate(Bundle state) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        theme = new NativeTheme(this);
        ScrollView scroll = new ScrollView(this); scroll.setBackgroundColor(theme.paper); scroll.setFillViewport(true);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            scroll.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(32), theme.dp(24), theme.dp(32)); scroll.addView(body); setContentView(scroll);
        TextView eyebrow = theme.eyebrow(); eyebrow.setText("MOSS / SETUP PROOF"); add(body, eyebrow);
        TextView heading = theme.text(30, true); heading.setText("Connect Moss"); add(body, heading);
        TextView intro = theme.text(15, false); intro.setText("Approve this separate test app in Moss. This checks account linking before ring setup. Your working companion stays in place."); add(body, intro);
        View rule = new View(this); rule.setBackgroundColor(theme.line); body.addView(rule, new LinearLayout.LayoutParams(-1, theme.dp(1)));
        TextView section = theme.text(20, true); section.setText("01  Moss account"); add(body, section);
        TextView label = theme.text(15, false); label.setText("Moss address"); label.setLabelFor(1201); add(body, label);
        address = new EditText(this); address.setId(1201); address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://your-moss-server"); address.setTextColor(theme.text); address.setHintTextColor(theme.muted);
        address.setTextSize(16); address.setMinHeight(theme.dp(48)); address.setSaveEnabled(false);
        address.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS); add(body, address);
        connect = button(body, "Connect Moss in browser", () -> {
            String origin = address.getText().toString().trim();
            perform(() -> new Outcome("Approve this phone in Moss, then return and check approval.", link.begin(origin), false));
        }, true);
        check = button(body, "Check approval", () -> perform(() -> {
            boolean confirmed = link.check();
            if (confirmed) evidence("linked");
            return new Outcome(confirmed ? "Moss account confirmed. Cancel this test link when the check is finished." : "Waiting for browser approval. No ring setup has started.", null, false);
        }), false);
        cancel = button(body, "Cancel / revoke test link", () -> perform(() -> {
            link.cancel(); evidence("cancelled");
            return new Outcome("Test link cancelled. Moss confirmed cleanup.", null, true);
        }), false);
        account = theme.text(15, false); add(body, account);
        status = theme.text(15, false); status.setId(1202); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); add(body, status);
        worker.execute(() -> {
            try {
                link = new SetupLink(this); SetupLink.Status initial = link.status();
                publish(initial, "Ready. Use your Moss server's HTTPS address.", null);
            } catch (Exception error) { publish(null, "Setup state needs recovery. Existing configuration and recordings are kept.", null); }
        });
        render();
    }
    private void add(LinearLayout body, View view) {
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.topMargin = theme.dp(12); body.addView(view, layout);
    }
    private Button button(LinearLayout body, String text, Runnable action, boolean primary) {
        Button result = theme.button(action, primary); result.setText(text); add(body, result); return result;
    }
    private static final class Outcome {
        final String message, browser;
        final boolean clearAddress;
        Outcome(String message, String browser, boolean clearAddress) { this.message = message; this.browser = browser; this.clearAddress = clearAddress; }
    }
    interface Work { Outcome run() throws Exception; }
    private void perform(Work work) {
        if (busy || link == null) return;
        busy = true; status.setText("Contacting Moss…"); render();
        worker.execute(() -> {
            Outcome outcome;
            try { outcome = work.run(); }
            catch (Exception error) { outcome = new Outcome(explain(error), null, false); }
            SetupLink.Status updated = null;
            try { updated = link.status(); } catch (Exception ignored) { }
            publish(updated, outcome.message, outcome);
        });
    }
    private void publish(SetupLink.Status updated, String message, Outcome outcome) {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            snapshot = updated; busy = false;
            if (outcome != null && outcome.clearAddress) address.setText("");
            if (updated != null && !updated.origin.isEmpty() && !address.getText().toString().equals(updated.origin)) address.setText(updated.origin);
            status.setText(message); render();
            if (outcome != null && outcome.browser != null) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(outcome.browser))); }
                catch (Exception unavailable) { status.setText("Install a browser, then reopen approval. The existing request is kept."); }
            }
        });
    }
    private void render() {
        SetupLink.Phase phase = snapshot == null ? SetupLink.Phase.RECOVERY : snapshot.phase;
        boolean ready = !busy && link != null && snapshot != null;
        address.setEnabled(ready && phase == SetupLink.Phase.EMPTY);
        connect.setEnabled(ready && (phase == SetupLink.Phase.EMPTY || phase == SetupLink.Phase.APPROVAL));
        connect.setText(phase == SetupLink.Phase.APPROVAL ? "Reopen browser approval" : "Connect Moss in browser");
        check.setEnabled(ready && (phase == SetupLink.Phase.APPROVAL || phase == SetupLink.Phase.CONFIRMING));
        cancel.setEnabled(ready && phase != SetupLink.Phase.EMPTY && phase != SetupLink.Phase.COMMITTED && phase != SetupLink.Phase.RECOVERY);
        account.setText(phase == SetupLink.Phase.LINKED ? "Account connected: " + snapshot.accountName : phase == SetupLink.Phase.CONFIRMING ? "Approval saved · account confirmation needed" :
            phase == SetupLink.Phase.CLEANUP ? "Interrupted setup · cleanup required" : phase == SetupLink.Phase.RECOVERY ? "Setup recovery required" : "Ring setup and delivery have not started.");
    }
    private void evidence(String result) throws Exception {
        PrivateFiles.json(new File(getNoBackupFilesDir(), "setup-link-proof.json"), new JSONObject().put("result", result).put("time", Instant.now().toString()));
    }
    private static String explain(Exception error) {
        String reason = error.getMessage();
        if (error instanceof MossClient.Rejected) {
            int status = ((MossClient.Rejected) error).status;
            if (status == 409) return "Approval may already have been redeemed. Cancel this test link before trying again.";
            if (status == 403) return "Approval was declined or the account is unavailable. Cancel this request before trying again.";
            if (status == 404 || status == 410) return "The approval request expired. Cancel it and connect again.";
        }
        if ("origin".equals(reason)) return "Enter a complete HTTPS Moss address with no page path, query or account details.";
        if ("link_expired".equals(reason)) return "The approval request expired. Cancel it and connect again.";
        if ("owner_mismatch".equals(reason)) return "Moss returned another account identity. Cancel this test link; no configuration was saved.";
        if ("setup_recovery_required".equals(reason) || "setup_already_configured".equals(reason)) return "Existing setup or recordings need recovery. No account was replaced.";
        if ("setup_cleanup_required".equals(reason)) return "The interrupted link needs cleanup. Cancel this test link before starting again.";
        if ("setup_origin_pinned".equals(reason)) return "Cancel the current request before changing the Moss address.";
        return "Could not complete the request. Check your connection and retry. Any unconfirmed cleanup remains pending.";
    }
    @Override public void onDestroy() { worker.shutdown(); super.onDestroy(); }
}
