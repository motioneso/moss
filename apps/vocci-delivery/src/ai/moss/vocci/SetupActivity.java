package ai.moss.vocci;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothManager;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** First-install UI over the same staged transaction exercised by the installed proof. */
public final class SetupActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private NativeTheme theme;
    private SetupLink link;
    private SetupLink.Status snapshot;
    private VocciAccount account;
    private ScrollView scroll;
    private LinearLayout body, mossSection, vocciSection, ringSection, readySection;
    private TextView title, intro;
    private SettingsRow savedRing;
    private EditText address, email, code;
    private TextView mossSummary, status, codeLabel, ringSummary, permissionSummary;
    private TextView deliverySummary;
    private Button connect, check, cancel, send, verifyCode, resend, changeEmail, resumeLookup, select, changeRing, verifyRing, nearby, appSettings, handoff;
    private RadioGroup rings;
    private List<JSONObject> inventory = Collections.emptyList();
    private boolean busy = true, lookedUp;
    private int restoreScroll;
    private final Runnable cooldown = new Runnable() {
        @Override public void run() { if (!busy) render(); handler.postDelayed(this, 1000); }
    };
    interface Work { String run() throws Exception; }

    @Override public void onCreate(Bundle saved) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        theme = new NativeTheme(this); theme.window();
        scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(theme.paper);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(12), theme.dp(24), theme.dp(32)); scroll.addView(body); setContentView(scroll); scroll.requestApplyInsets();
        button(body, "‹ Back", this::finish, false);
        TextView brand = theme.eyebrow(); brand.setText("HARDWARE / VOCCI RING"); add(body, brand);
        title = text(body, "Set up your ring", 30, true);
        intro = text(body, "Connect the Vocci ring you already own. Finished recordings go to Meetings.", 15, false);
        status = text(body, "Opening saved setup…", 15, false); status.setId(3104);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        savedRing = new SettingsRow(theme); add(body, savedRing); savedRing.setVisibility(View.GONE);
        mossSection = section("Moss account");
        LinearLayout moss = mossSection;
        address = field(moss, "Moss address", 3101, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://your-moss-server");
        connect = button(moss, "Connect Moss in browser", () -> {
            String origin = address.getText().toString().trim();
            perform(() -> {
                String approval = link.begin(origin);
                runOnUiThread(() -> { if (!isDestroyed()) open(new Intent(Intent.ACTION_VIEW, Uri.parse(approval))); });
                return "Approve this phone in Moss, then return and check approval.";
            });
        }, true);
        check = button(moss, "Check approval", () -> perform(() -> link.check() ?
            "Moss account connected. Continue with the Vocci account that owns your ring." : "Waiting for browser approval."), false);
        mossSummary = text(moss, "Opening saved setup…", 15, false);

        vocciSection = section("Vocci account");
        text(vocciSection, "Use the account that owns your ring. Vocci sends an email code when you choose Send code.", 15, false);
        email = field(vocciSection, "Vocci email", 3102, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        send = button(vocciSection, "Send code", () -> {
            String value = email.getText().toString().trim();
            perform(() -> { account.begin(value); return "Code sent. Enter the six-digit code from Vocci."; });
        }, true);
        codeLabel = text(vocciSection, "Email code", 15, false);
        code = input(vocciSection, 3103, InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        codeLabel.setLabelFor(code.getId());
        verifyCode = button(vocciSection, "Verify code", () -> {
            String value = code.getText().toString().trim(); code.setText("");
            perform(() -> {
                account.verify(value);
                return account.step() == VocciAccount.Step.TOTP ? "Enter the code from your authenticator app." : lookup();
            });
        }, true);
        resend = button(vocciSection, "Resend code", () -> perform(() -> { account.resend(); return "New code sent. Use the latest email."; }), false);
        resumeLookup = button(vocciSection, "Finish ring lookup", () -> perform(() -> { account.resumeLookup(); return lookup(); }), true);
        changeEmail = button(vocciSection, "Use another email", () -> perform(() -> {
            account.cleanup(); inventory = Collections.emptyList(); lookedUp = false;
            return "Vocci confirmed sign-in cleanup. You can enter another email.";
        }), false);

        ringSection = section("Your ring");
        text(ringSection, "Rings on your Vocci account. Choose yours, then verify it nearby with Bluetooth on.", 15, false);
        ringSummary = text(ringSection, "Sign into Vocci to list your existing rings.", 15, false);
        rings = new RadioGroup(this); add(ringSection, rings);
        select = button(ringSection, "Select ring", () -> {
            int index = rings.getCheckedRadioButtonId() - 3200;
            if (index < 0 || index >= inventory.size()) return;
            JSONObject binding = inventory.get(index);
            perform(() -> { link.selectBinding(binding); inventory = Collections.emptyList(); return "Ring selected. Complete the Bluetooth handoff, then verify."; });
        }, true);
        rings.setOnCheckedChangeListener((group, id) -> select.setEnabled(!busy && id >= 3200));
        changeRing = button(ringSection, "Choose another ring", () -> perform(() -> {
            link.clearBinding(); inventory = Collections.emptyList(); lookedUp = false;
            return "Moss stays connected. Sign into Vocci again to choose another ring.";
        }), false);
        text(ringSection, "If you use the Vocci app, remove its Nearby devices permission before verifying here. Your ring and recordings are kept.", 15, false);
        handoff = button(ringSection, "Open Vocci app settings", () -> settings(DeliveryService.OFFICIAL), false);
        nearby = button(ringSection, "Allow Nearby devices", () -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, 31), false);
        appSettings = button(ringSection, "Open companion app settings", () -> settings(getPackageName()), false);
        permissionSummary = text(ringSection, "", 15, false);
        verifyRing = button(ringSection, "Verify ring", () -> perform(() -> {
            if (!bluetoothAllowed()) return "Allow Nearby devices in this app's settings before verifying.";
            if (!bluetoothOn()) return "Turn on Bluetooth, then retry Verify ring.";
            if (officialAllowed()) return "Remove Vocci's Nearby devices permission, return here, then retry Verify ring.";
            link.verifyAndCommit(); return "Ring verified and setup saved. Delivery and hold-to-talk are still off.";
        }), true);

        readySection = section("Ready");
        deliverySummary = text(readySection, "", 15, false);
        button(readySection, "Continue to Vocci ring", () -> {
            startActivity(new Intent(this, DeliveryActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)); finish();
        }, true);
        cancel = button(body, "Cancel setup", () -> perform(() -> {
            account.cleanup(); link.cancel(); inventory = Collections.emptyList(); lookedUp = false;
            return "Setup cancelled. Remote cleanup was confirmed. No delivery has started.";
        }), false);
        if (saved != null) {
            email.setText(saved.getString("email", "")); address.setText(saved.getString("address", ""));
            restoreScroll = saved.getInt("scrollY");
        }
        render();
        worker.execute(() -> {
            String message;
            try {
                link = new SetupLink(this); account = new VocciAccount(this); snapshot = link.status();
                message = account.canResumeLookup() ? "Verified Vocci sign-in is saved. Finish ring lookup or clean up the sign-in." :
                    account.step() == VocciAccount.Step.CLEANUP ? "An interrupted Vocci sign-in needs cleanup before another email code." :
                    snapshot.phase == SetupLink.Phase.COMMITTED ? "Setup saved. Your delivery choices are kept." : "Connect Moss to get started. Sending a code is your choice.";
            } catch (Exception error) { message = "Existing setup or recordings need recovery. No account or ring was replaced. Return to the companion to review recovery."; }
            publish(message);
        });
    }
    private String lookup() throws Exception {
        List<JSONObject> found = account.bindings();
        account.cleanup(); // Do not display reusable inventory before temporary-session cleanup succeeds.
        inventory = found; lookedUp = true;
        return found.isEmpty() ? "No rings on this Vocci account. Establish ownership in Vocci first, then retry." : "Vocci sign-in cleaned up. Choose a ring from your account.";
    }
    private LinearLayout section(String title) {
        LinearLayout result = new LinearLayout(this); result.setOrientation(LinearLayout.VERTICAL); add(body, result);
        View rule = new View(this); rule.setBackgroundColor(theme.line); result.addView(rule, new LinearLayout.LayoutParams(-1, theme.dp(1)));
        text(result, title, 20, true); return result;
    }
    private void add(LinearLayout parent, View view) {
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.topMargin = theme.dp(12); parent.addView(view, layout);
    }
    private TextView text(LinearLayout parent, String value, int size, boolean heading) {
        TextView result = theme.text(size, heading); result.setText(value); add(parent, result); return result;
    }
    private Button button(LinearLayout parent, String label, Runnable action, boolean primary) {
        Button result = theme.button(action, primary); result.setText(label); add(parent, result); return result;
    }
    private EditText input(LinearLayout parent, int id, int type) {
        EditText field = new EditText(this); field.setId(id); field.setInputType(type); field.setSingleLine(true);
        field.setTextColor(theme.text); field.setHintTextColor(theme.muted); field.setTextSize(16); field.setMinHeight(theme.dp(48));
        field.setSaveEnabled(false); field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS); add(parent, field); return field;
    }
    private EditText field(LinearLayout parent, String label, int id, int type) {
        TextView title = text(parent, label, 15, false); EditText field = input(parent, id, type); title.setLabelFor(id); return field;
    }
    private void perform(Work work) {
        if (busy || link == null || account == null) return;
        busy = true; status.setText("Working…"); render();
        worker.execute(() -> {
            String message;
            try { message = work.run(); }
            catch (Exception error) { message = SetupMessages.explain(error); }
            try { snapshot = link.status(); } catch (Exception recovery) { snapshot = null; }
            publish(message);
        });
    }
    private void publish(String message) {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            busy = false;
            if (snapshot != null && !snapshot.origin.isEmpty()) NativeTheme.update(address, snapshot.origin);
            status.setText(message); updateInventory(); render();
            if (restoreScroll != 0) { int y = restoreScroll; restoreScroll = 0; scroll.post(() -> scroll.scrollTo(0, y)); }
        });
    }
    private void updateInventory() {
        // Rebuild only after an explicit action, never while a field is being edited or a cooldown ticks.
        rings.removeAllViews();
        for (int i = 0; i < inventory.size(); i++) {
            RadioButton row = new RadioButton(this); row.setId(3200 + i); String serial = inventory.get(i).optString("sn");
            row.setText("Ring …" + serial.substring(Math.max(0, serial.length() - 6)));
            row.setTextColor(theme.text); row.setTextSize(16); row.setMinHeight(theme.dp(48)); rings.addView(row);
        }
    }
    private void render() {
        SetupLink.Phase phase = snapshot == null ? SetupLink.Phase.RECOVERY : snapshot.phase;
        boolean linked = phase == SetupLink.Phase.LINKED, committed = phase == SetupLink.Phase.COMMITTED;
        boolean selected = snapshot != null && snapshot.ringSelected;
        NativeTheme.update(title, committed ? "Ring connection" : "Set up your ring");
        intro.setVisibility(committed ? View.GONE : View.VISIBLE);
        mossSection.setVisibility(committed ? View.GONE : View.VISIBLE);
        savedRing.setVisibility(committed ? View.VISIBLE : View.GONE);
        if (committed) savedRing.update("Vocci ring · …" + snapshot.ringSuffix,
            "Connected to " + snapshot.accountName, () -> startActivity(new Intent(this, DeliveryActivity.class)));

        boolean enabled = !busy && account != null && snapshot != null;
        address.setEnabled(enabled && phase == SetupLink.Phase.EMPTY);
        connect.setEnabled(enabled && (phase == SetupLink.Phase.EMPTY || phase == SetupLink.Phase.APPROVAL));
        NativeTheme.update(connect, phase == SetupLink.Phase.APPROVAL ? "Reopen browser approval" : "Connect Moss in browser");
        check.setVisibility(phase == SetupLink.Phase.APPROVAL || phase == SetupLink.Phase.CONFIRMING ? View.VISIBLE : View.GONE);
        check.setEnabled(enabled && (phase == SetupLink.Phase.APPROVAL || phase == SetupLink.Phase.CONFIRMING));
        NativeTheme.update(mossSummary, linked || committed ? "Account connected: " + snapshot.accountName + (committed ? "\nRing …" + snapshot.ringSuffix + " verified. Setup saved." : "") :
            phase == SetupLink.Phase.CLEANUP ? "Interrupted setup: cancellation needs network access to finish cleanup." :
            phase == SetupLink.Phase.RECOVERY ? "Saved setup needs recovery. Existing recordings are kept." :
            phase == SetupLink.Phase.EMPTY ? "Connect Moss before signing into Vocci." : "Browser approval waiting / account confirmation needed.");
        vocciSection.setVisibility(linked && !selected ? View.VISIBLE : View.GONE);
        ringSection.setVisibility(linked ? View.VISIBLE : View.GONE);
        readySection.setVisibility(committed ? View.VISIBLE : View.GONE);
        renderReady();
        VocciAccount.Step step = account == null ? VocciAccount.Step.CLEANUP : account.step();
        boolean authEnabled = enabled && linked && !selected;
        email.setEnabled(authEnabled && step == VocciAccount.Step.EMAIL);
        send.setEnabled(authEnabled && step == VocciAccount.Step.EMAIL);
        boolean entering = step == VocciAccount.Step.CODE || step == VocciAccount.Step.TOTP;
        codeLabel.setVisibility(entering ? View.VISIBLE : View.GONE); code.setVisibility(entering ? View.VISIBLE : View.GONE);
        verifyCode.setVisibility(entering ? View.VISIBLE : View.GONE);
        resend.setVisibility(step == VocciAccount.Step.CODE ? View.VISIBLE : View.GONE);
        changeEmail.setVisibility(step != VocciAccount.Step.EMAIL || lookedUp ? View.VISIBLE : View.GONE);
        send.setVisibility(step == VocciAccount.Step.EMAIL ? View.VISIBLE : View.GONE);

        code.setEnabled(authEnabled && entering); verifyCode.setEnabled(authEnabled && entering);
        NativeTheme.update(codeLabel, step == VocciAccount.Step.TOTP ? "Authenticator code" : "Email code");
        long seconds = account == null ? 0 : Math.max(0, (account.resendAfter() - System.currentTimeMillis() + 999) / 1000);
        resend.setEnabled(authEnabled && step == VocciAccount.Step.CODE && seconds == 0);
        NativeTheme.update(resend, seconds > 0 ? "Resend code in " + seconds + "s" : "Resend code");
        resumeLookup.setVisibility(account != null && account.canResumeLookup() ? View.VISIBLE : View.GONE);
        resumeLookup.setEnabled(authEnabled);
        changeEmail.setEnabled(authEnabled && (step != VocciAccount.Step.EMAIL || lookedUp));
        select.setVisibility(inventory.isEmpty() ? View.GONE : View.VISIBLE);
        select.setEnabled(enabled && rings.getCheckedRadioButtonId() >= 3200);
        changeRing.setVisibility(linked && selected ? View.VISIBLE : View.GONE);
        changeRing.setEnabled(enabled && linked && selected);
        for (int i = 0; i < rings.getChildCount(); i++) rings.getChildAt(i).setEnabled(enabled);
        NativeTheme.update(ringSummary, selected ? "Ring …" + snapshot.ringSuffix + " selected. Keep it nearby, then verify." :
            !inventory.isEmpty() ? "Choose a ring listed on your Vocci account." : lookedUp ? "No rings are listed. Establish ownership in Vocci first, then retry." : "Sign into Vocci to list your existing rings.");
        NativeTheme.update(permissionSummary, "Nearby devices: " + (bluetoothAllowed() ? "allowed" : "needed") + " · Bluetooth: " + (bluetoothOn() ? "on" : "off or unavailable") +
            "\nVocci Nearby devices: " + (officialAllowed() ? "remove access in Vocci app settings" : "handoff ready"));
        verifyRing.setEnabled(enabled && selected);
        nearby.setEnabled(enabled); appSettings.setEnabled(enabled); handoff.setEnabled(enabled);
        cancel.setVisibility(committed ? View.GONE : View.VISIBLE);
        cancel.setEnabled(enabled && phase != SetupLink.Phase.RECOVERY && (phase != SetupLink.Phase.EMPTY || step != VocciAccount.Step.EMAIL));
    }
    private void renderReady() {
        DeliveryPreferences choices = new DeliveryPreferences(this);
        NativeTheme.update(deliverySummary, choices.enabled() ? "Delivery is on. Manage your choices in Settings." : "Setup saved. Start delivery from Vocci ring when you’re ready.");
    }
    private boolean bluetoothAllowed() { return checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED; }
    private boolean bluetoothOn() {
        if (!bluetoothAllowed()) return false;
        try { BluetoothManager manager = getSystemService(BluetoothManager.class); return manager != null && manager.getAdapter() != null && manager.getAdapter().isEnabled(); }
        catch (SecurityException denied) { return false; }
    }
    private boolean officialAllowed() {
        return getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, DeliveryService.OFFICIAL) == PackageManager.PERMISSION_GRANTED;
    }
    private void settings(String packageName) { open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName))); }
    private void open(Intent intent) {
        try { startActivity(intent); }
        catch (ActivityNotFoundException unavailable) { status.setText("Open the browser or app permissions from Android Settings, then return here. Your setup is kept."); }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants); render();
    }
    @Override public void onSaveInstanceState(Bundle saved) {
        saved.putString("email", email.getText().toString()); saved.putString("address", address.getText().toString()); saved.putInt("scrollY", scroll.getScrollY());
        super.onSaveInstanceState(saved);
    }
    @Override public void onResume() { super.onResume(); handler.post(cooldown); }
    @Override public void onPause() { handler.removeCallbacks(cooldown); super.onPause(); }
    @Override public void onDestroy() { code.setText(""); inventory = Collections.emptyList(); worker.shutdown(); super.onDestroy(); }
}
