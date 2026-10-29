package ai.moss.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.view.View;
import android.widget.*;
import java.io.File;
import java.time.Instant;
import java.util.*;
import org.json.JSONObject;

/** Development-only selected-ring UI. Inventory keys live only until explicit selection. */
final class RingSetupProofPanel {
    interface Runner { void run(VocciProofActivity.Work work); }
    private final Activity activity;
    private final NativeTheme theme;
    private final Runner runner;
    private final LinearLayout body;
    private final TextView summary;
    private final RadioGroup choices;
    private final Button select, permission, handoff, verify;
    private List<JSONObject> inventory = Collections.emptyList(), rendered;
    private boolean lookedUp;
    private SetupLink link;
    private SetupLink.Status snapshot;
    RingSetupProofPanel(Activity activity, NativeTheme theme, LinearLayout parent, Runner runner) {
        this.activity = activity; this.theme = theme; this.runner = runner;
        body = new LinearLayout(activity); body.setOrientation(LinearLayout.VERTICAL); parent.addView(body);
        View rule = new View(activity); rule.setBackgroundColor(theme.line); body.addView(rule, new LinearLayout.LayoutParams(-1, theme.dp(1)));
        TextView title = theme.text(22, true); title.setText("03  Your ring"); add(title);
        summary = theme.text(15, false); add(summary);
        choices = new RadioGroup(activity); add(choices);
        select = button("Select ring", () -> {
            int index = choices.getCheckedRadioButtonId() - 2100;
            if (index < 0 || index >= inventory.size()) return;
            JSONObject binding = inventory.get(index);
            runner.run(() -> {
                link.selectBinding(binding); inventory = Collections.emptyList(); refresh();
                return "Ring selected. Allow Nearby devices and complete the handoff, then verify.";
            });
        }, true);
        choices.setOnCheckedChangeListener((group, id) -> select.setEnabled(id >= 2100 && group.isEnabled()));
        permission = button("Allow Nearby devices", () -> activity.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, 21), false);
        handoff = button("Open Vocci app settings", () -> {
            try { activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + DeliveryService.OFFICIAL))); }
            catch (Exception unavailable) { summary.setText("Open Android Settings → Apps → Vocci → Permissions and remove Nearby devices access."); }
        }, false);
        TextView help = theme.text(15, false);
        help.setText("This list comes from your Vocci account, not a nearby-device scan. Keep the ring close, turn on Bluetooth, pause delivery in your working companion, and remove Vocci's Nearby devices permission before this check."); add(help);
        verify = button("Verify ring and save test setup", () -> runner.run(() -> {
            try {
                if (activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                    return "Allow Nearby devices before verifying the ring.";
                if (officialPermission()) return "Remove Vocci's Nearby devices permission in its app settings, then return and retry.";
                link.verifyAndCommit(); refresh();
                PrivateFiles.json(new File(activity.getNoBackupFilesDir(), "setup-ring-proof.json"), new JSONObject()
                    .put("configurationCommitted", true).put("time", Instant.now().toString()));
                return "Ring identity and key verified. Test setup saved. Delivery and hold-to-talk have not started.";
            } catch (Exception error) {
                refresh();
                String reason = error.getMessage();
                if ("owner_mismatch".equals(reason)) return "The Moss account changed. Cancel the staged link; no configuration was saved.";
                if ("ring_identity".equals(reason)) return "The physical ring identity did not match. Keep the selected ring nearby and retry.";
                if ("ring_challenge".equals(reason) || "ring_start_app".equals(reason)) return "The ring did not accept this account's key. Retry account lookup; no configuration was saved.";
                if (snapshot != null && snapshot.phase == SetupLink.Phase.COMMITTED) return "The complete test setup is saved. Delivery has not started.";
                return "Verification did not finish. Check Bluetooth, the selected ring and your Moss connection, then retry. No delivery has started.";
            }
        }), true);
        body.setVisibility(View.GONE);
    }
    void initialize() {
        try { link = new SetupLink(activity); refresh(); }
        catch (Exception recovery) { snapshot = null; }
    }
    void refresh() throws Exception { if (link != null) snapshot = link.status(); }
    void offer(List<JSONObject> bindings) throws Exception {
        refresh();
        if (snapshot != null && snapshot.phase == SetupLink.Phase.LINKED) { inventory = new ArrayList<>(bindings); lookedUp = true; }
    }
    void release() { inventory = Collections.emptyList(); rendered = null; }
    private boolean officialPermission() {
        return activity.getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, DeliveryService.OFFICIAL) == PackageManager.PERMISSION_GRANTED;
    }
    void render(boolean busy) {
        boolean linked = snapshot != null && snapshot.phase == SetupLink.Phase.LINKED;
        boolean committed = snapshot != null && snapshot.phase == SetupLink.Phase.COMMITTED;
        body.setVisibility(linked || committed ? View.VISIBLE : View.GONE);
        if (!linked && !committed) return;
        if (rendered != inventory) {
            choices.removeAllViews(); rendered = inventory;
            for (int i = 0; i < inventory.size(); i++) {
                String serial = inventory.get(i).optString("sn");
                RadioButton row = new RadioButton(activity); row.setId(2100 + i);
                row.setText("Ring …" + serial.substring(Math.max(0, serial.length() - 6)));
                row.setButtonTintList(android.content.res.ColorStateList.valueOf(theme.accentText));
                row.setTextColor(theme.text); row.setTextSize(16); row.setMinHeight(theme.dp(48)); choices.addView(row);
            }
        }
        summary.setText(committed ? "Complete test configuration saved. Delivery remains off." : snapshot.ringSelected ?
            "Selected ring …" + snapshot.ringSuffix + ". Physical verification is still required." :
            inventory.isEmpty() ? lookedUp ? "No rings are listed on this Vocci account. Establish ownership in Vocci first, then retry this lookup." : "Sign into Vocci above to list rings already on your account." : "Rings on your Vocci account. Choose the ring you want to verify.");
        select.setVisibility(inventory.isEmpty() ? View.GONE : View.VISIBLE); select.setEnabled(!busy && choices.getCheckedRadioButtonId() >= 2100);
        choices.setEnabled(!busy);
        for (int i = 0; i < choices.getChildCount(); i++) choices.getChildAt(i).setEnabled(!busy);
        permission.setEnabled(!busy && linked); handoff.setEnabled(!busy && linked);
        verify.setEnabled(!busy && linked && snapshot.ringSelected);
    }
    private void add(View view) {
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.topMargin = theme.dp(12); body.addView(view, layout);
    }
    private Button button(String label, Runnable action, boolean primary) {
        Button button = theme.button(action, primary); button.setText(label); add(button); return button;
    }
}
