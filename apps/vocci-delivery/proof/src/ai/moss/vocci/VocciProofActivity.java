package ai.moss.vocci;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import java.util.concurrent.*;
import java.io.File;
import org.json.JSONObject;

/** Isolated feasibility UI. No service, ring permissions, Moss credential or delivery config. */
public final class VocciProofActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private NativeTheme theme;
    private VocciAccount account;
    private EditText email, code;
    private TextView status, codeLabel;
    private Button send, verify, resend, cleanup;
    private boolean busy = true;
    private int found = -1;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        theme = new NativeTheme(this);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(theme.paper);
        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(36), theme.dp(24), theme.dp(32)); scroll.addView(body); setContentView(scroll);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            scroll.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        TextView eyebrow = theme.eyebrow(); eyebrow.setText("MOSS / SETUP PROOF"); add(body, eyebrow);
        TextView heading = theme.text(30, true); heading.setText("Connect Vocci"); add(body, heading);
        TextView intro = theme.text(15, false);
        intro.setText("Sign into the existing Vocci account that owns your ring. Vocci sends an email code. This separate test checks account access; your working companion stays in place."); add(body, intro);
        TextView label = theme.text(15, false); label.setText("Vocci email"); add(body, label);
        email = input(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, 1101); label.setLabelFor(email.getId()); add(body, email);
        send = button(body, "Send code", () -> {
            String value = email.getText().toString().trim();
            perform(() -> { account.begin(value); return "Code sent. Enter the six-digit code from Vocci."; });
        }, true);
        codeLabel = theme.text(15, false); codeLabel.setText("Email code"); add(body, codeLabel);
        code = input(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD, 1102); codeLabel.setLabelFor(code.getId()); add(body, code);
        verify = button(body, "Verify code", () -> {
            String value = code.getText().toString().trim(); code.setText("");
            perform(() -> {
                account.verify(value);
                if (account.step() == VocciAccount.Step.TOTP) return "Enter the code from your authenticator app.";
                found = account.bindings().size();
                evidence(false);
                account.cleanup();
                evidence(true);
                return "Sign-in proof passed: " + found + " owned ring(s). Temporary Vocci session removed. No ring binding was changed.";
            });
        }, true);
        resend = button(body, "Resend code", () -> perform(() -> { account.resend(); return "New code sent. Use the latest email."; }), false);
        cleanup = button(body, "Cancel / clean up session", () -> perform(() -> {
            account.cleanup();
            if (found >= 0) evidence(true);
            return found >= 0 ? "Lookup passed: " + found + " owned ring(s). Temporary session removed." : "Temporary session cleaned up. You can start again.";
        }), false);
        status = theme.text(15, false); status.setId(1103); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); add(body, status);
        worker.execute(() -> {
            String message;
            try {
                account = new VocciAccount(this);
                message = account.step() == VocciAccount.Step.CLEANUP ? "An interrupted attempt needs cleanup before a new code can be sent." : "Ready. Sending a code starts Vocci sign-in for this test.";
            } catch (Exception error) { message = "Encrypted setup state could not be opened. Existing companion data is unaffected."; }
            String ready = message; runOnUiThread(() -> { busy = false; status.setText(ready); render(); });
        });
        render();
    }
    private EditText input(int type, int id) {
        EditText field = new EditText(this); field.setId(id); field.setInputType(type); field.setSingleLine(true);
        field.setTextColor(theme.text); field.setTextSize(16); field.setMinHeight(theme.dp(48));
        field.setSaveEnabled(false); field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        return field;
    }
    private void add(LinearLayout parent, View view) {
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.bottomMargin = theme.dp(12); parent.addView(view, layout);
    }
    private Button button(LinearLayout body, String title, Runnable action, boolean primary) {
        Button view = theme.button(action, primary); view.setText(title); add(body, view); return view;
    }
    interface Work { String run() throws Exception; }
    private void evidence(boolean cleaned) throws Exception {
        PrivateFiles.json(new File(getNoBackupFilesDir(), "auth-proof-result.json"), new JSONObject()
            .put("bindingBackendAccepted", true).put("ownedRingCount", found).put("cleanupConfirmed", cleaned)
            .put("clientIdentity", VocciHttp.USER_AGENT).put("time", java.time.Instant.now().toString()));
    }
    private void perform(Work work) {
        if (busy || account == null) return;
        busy = true; status.setText("Contacting Vocci…"); render();
        worker.execute(() -> {
            String message;
            try { message = work.run(); }
            catch (VocciHttp.Failure failure) {
                message = explanation(failure.code);
                try { PrivateFiles.json(new File(getNoBackupFilesDir(), "auth-proof-error.json"), new JSONObject().put("code", failure.code).put("time", java.time.Instant.now().toString())); }
                catch (Exception ignored) { }
            }
            catch (Exception failure) { message = "Setup could not continue. Clean up this attempt before trying again."; }
            String result = message;
            runOnUiThread(() -> { if (!isDestroyed()) { busy = false; status.setText(result); render(); } });
        });
    }
    private void render() {
        VocciAccount.Step step = account == null ? VocciAccount.Step.CLEANUP : account.step();
        boolean ready = !busy && account != null;
        email.setEnabled(ready && step == VocciAccount.Step.EMAIL);
        send.setEnabled(ready && step == VocciAccount.Step.EMAIL);
        codeLabel.setText(step == VocciAccount.Step.TOTP ? "Authenticator code" : "Email code");
        code.setEnabled(ready && (step == VocciAccount.Step.CODE || step == VocciAccount.Step.TOTP));
        verify.setEnabled(code.isEnabled()); resend.setEnabled(ready && step == VocciAccount.Step.CODE);
        cleanup.setEnabled(ready && step != VocciAccount.Step.EMAIL);
    }
    private static String explanation(String code) {
        switch (code) {
            case "auth_response_invalid": return "Vocci returned sign-in details this client could not validate. Clean up this attempt.";
            case "auth_client_changed": return "Vocci changed the temporary sign-in session unexpectedly. Clean up this attempt before continuing.";
            case "auth_request_failed": return "Vocci did not accept the sign-in request. Clean up this attempt before trying again.";
            case "auth_email_invalid": return "Enter the email address used for Vocci.";
            case "auth_code_invalid": case "auth_code_incorrect": return "That code was not accepted. Enter the six-digit code and try again.";
            case "auth_code_expired": return "The code expired. Request a new email code.";
            case "auth_resend_wait": case "auth_rate_limited": return "Please wait before requesting another code. Vocci limits repeated attempts.";
            case "auth_account_not_found": return "No existing Vocci account was found. Clean up and check the email. This flow does not create an account.";
            case "auth_method_unsupported": return "This account requires a sign-in method this test does not support. Clean up this attempt.";
            case "auth_service_rejected": return "Vocci rejected this client's request. Setup is blocked; no workaround has been attempted.";
            case "auth_network_unavailable": return "Could not reach Vocci. Check your connection. Cleanup remains available if the attempt was interrupted.";
            case "binding_identity_ambiguous": case "binding_response_invalid": return "Vocci returned ring details that cannot be verified. Clean up this attempt.";
            default: return "Vocci setup could not be confirmed. Clean up this attempt before starting again.";
        }
    }
    @Override public void onDestroy() {
        code.setText(""); worker.shutdown(); super.onDestroy();
    }
}
