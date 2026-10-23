package ai.moss.vocci;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.drawable.ColorDrawable;
import android.os.*;
import android.text.format.DateUtils;
import android.view.*;
import android.widget.*;
import java.io.File;
import java.util.*;
import java.util.function.Supplier;
import org.json.JSONObject;

/** Settings > Hardware. This screen reads snapshots; opening it never starts ring delivery. */
public final class HardwareActivity extends Activity {
    private NativeTheme theme;
    private LinearLayout body;
    private ScrollView scroll;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, View> views = new LinkedHashMap<>();
    private final Set<String> used = new HashSet<>();
    private String page = "hardware";
    private int position;
    private boolean updating;
    private Boolean deliveryChoice;
    private long deliveryChoiceAt;
    private Integer restoreY;
    private final Runnable refresh = new Runnable() {
        @Override public void run() { render(); handler.postDelayed(this, 3000); }
    };
    @Override public void onCreate(Bundle saved) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(saved);
        if (!new SecretStore(this).exists()) {
            startActivity(new Intent(this, SetupActivity.class)); finish(); return;
        }
        theme = new NativeTheme(this);
        getWindow().setBackgroundDrawable(new ColorDrawable(theme.paper)); getWindow().setDecorFitsSystemWindows(false);
        getWindow().getDecorView().getWindowInsetsController().setSystemBarsAppearance(theme.dark ? 0 :
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(theme.paper);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(12), theme.dp(24), theme.dp(32)); scroll.addView(body);
        setContentView(scroll); scroll.requestApplyInsets();
        if (saved != null) { page = saved.getString("page", "hardware"); restoreY = saved.getInt("scrollY"); }
    }
    @Override public void onResume() { super.onResume(); if (body != null) handler.post(refresh); }
    @Override public void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
    @Override public void onSaveInstanceState(Bundle saved) {
        saved.putString("page", page); if (scroll != null) saved.putInt("scrollY", scroll.getScrollY()); super.onSaveInstanceState(saved);
    }
    @Override public void onBackPressed() {
        if (page.equals("hardware")) super.onBackPressed(); else show(page.equals("ring") ? "hardware" : "ring");
    }
    private void show(String next) { page = next; render(); scroll.scrollTo(0, 0); }
    private <T extends View> T place(String key, Class<T> type, Supplier<T> factory, int gap) {
        key = page + "/" + key;
        View view = views.get(key);
        if (view == null) { view = factory.get(); views.put(key, view); }
        used.add(key);
        if (body.indexOfChild(view) != position) {
            if (view.getParent() == body) body.removeView(view);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = theme.dp(gap);
            body.addView(view, position, params);
        }
        position++; return type.cast(view);
    }
    private void text(String key, String value, int size, boolean heading) {
        NativeTheme.update(place(key, TextView.class, () -> theme.text(size, heading), 12), value);
    }
    private void rule(String key) {
        View line = place(key, View.class, () -> new View(this), 16);
        line.setBackgroundColor(theme.line); line.getLayoutParams().height = theme.dp(1);
    }
    private void row(String key, String title, String detail, Runnable action) {
        place(key, SettingsRow.class, () -> new SettingsRow(theme), 0).update(title, detail, action); rule(key + "-rule");
    }
    private void button(String key, String title, Runnable action) {
        Button button = place(key, Button.class, () -> theme.button(action, false), 12);
        NativeTheme.update(button, title); button.setOnClickListener(v -> action.run());
    }
    private Switch toggle(String key, String label, boolean checked, java.util.function.Consumer<Boolean> action) {
        Switch control = place(key, Switch.class, () -> {
            Switch view = new Switch(this); theme.toggle(view); view.setText(label);
            view.setOnCheckedChangeListener((v, value) -> { if (!updating) { action.accept(value); render(); } }); return view;
        }, 12);
        updating = true;
        try { control.setChecked(checked); } finally { updating = false; }
        return control;
    }
    private String command(String action) {
        String result = DeliveryActions.command(this, action);
        Toast.makeText(this, result, Toast.LENGTH_LONG).show(); return result;
    }
    private void diagnostics() { startActivity(new Intent(this, DeliveryActivity.class)); }
    private JSONObject delivery() {
        try { return PrivateFiles.json(new File(getNoBackupFilesDir(), "delivery/state.json")); }
        catch (Exception unavailable) { return new JSONObject(); }
    }
    private String phoneStorage(JSONObject entries) {
        if (entries == null) return "No delivery snapshot available yet.";
        try { return DeliveryStatus.storage(new File(getNoBackupFilesDir(), "delivery"), entries); }
        catch (Exception unavailable) { return "Phone audio usage could not be checked. Delivery details keeps your queue available."; }
    }
    private String observed(long time) {
        if (time <= 0 || time > System.currentTimeMillis() + 60000) return "Not checked yet";
        return "Last checked " + DateUtils.getRelativeTimeSpanString(time, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS);
    }
    private String field(JSONObject parent, String name, String value) {
        JSONObject item = parent.optJSONObject(name);
        return item == null ? "Not checked yet" : value + " · " + observed(item.optLong("at"));
    }
    private String battery(JSONObject snapshot) {
        JSONObject info = snapshot.optJSONObject("info"); int value = info == null ? -1 : info.optInt("battery", -1);
        return field(snapshot, "info", value >= 0 && value <= 100 ? "Battery " + value + "%" : "Battery unavailable");
    }
    private String recording(JSONObject snapshot) {
        JSONObject state = snapshot.optJSONObject("recording");
        return field(snapshot, "recording", HardwareStatus.recordingLabel(state == null ? "" : state.optString("state")));
    }
    private static String bytes(long size) { return String.format(Locale.getDefault(), "%.1f MiB", size / 1048576.0); }
    private void render() {
        position = 0; used.clear();
        DeliveryPreferences choices = new DeliveryPreferences(this);
        if (deliveryChoice != null && (choices.enabled() == deliveryChoice || SystemClock.elapsedRealtime() - deliveryChoiceAt >= 5000)) deliveryChoice = null;
        JSONObject config = null;
        try { config = new SecretStore(this).load(); } catch (Exception unavailable) { /* Show setup/recovery, keep existing data. */ }
        final JSONObject snapshot = config == null ? new JSONObject() : HardwareStatus.read(this, config);
        final JSONObject state = delivery(), voice = state.optJSONObject("voice");
        if (!page.equals("hardware")) button("back", "‹ " + (page.equals("ring") ? "Hardware" : "Vocci ring"), this::onBackPressed);
        NativeTheme.update(place("eyebrow", TextView.class, () -> theme.eyebrow(), 12), "MOSS / SETTINGS / HARDWARE");
        switch (page) {
            case "hardware":
                text("title", "Hardware", 30, true);
                text("intro", "The devices you use with Moss.", 15, false); rule("head-rule");
                row("ring", "Vocci ring", config == null ? "Set up or recover your ring connection" : battery(snapshot),
                    () -> { if (new SecretStore(this).exists()) show("ring"); else startActivity(new Intent(this, SetupActivity.class)); });
                if (config == null) text("setup-note", "Setup keeps your existing ring and pending audio. It starts no recording or delivery.", 13, false);
                break;
            case "ring":
                text("title", "Vocci ring", 30, true);
                text("contact", snapshot.has("contactAt") ? "Last ring contact · " + observed(snapshot.optLong("contactAt")) : "Waiting for a ring status check", 13, false);
                text("battery", battery(snapshot), 15, false); text("recording", recording(snapshot), 15, false);
                text("status-note", "Status is a saved observation. It refreshes while automatic delivery is running and the ring is nearby.", 13, false);
                rule("status-rule");
                Switch delivery = toggle("delivery", "Automatic delivery", deliveryChoice == null ? choices.enabled() : deliveryChoice, enabled -> {
                    if (enabled) {
                        if (DeliveryActions.CHANGE_QUEUED.equals(command("start"))) { deliveryChoice = true; deliveryChoiceAt = SystemClock.elapsedRealtime(); }
                    } else DeliveryActions.stop(this);
                });
                delivery.setEnabled(deliveryChoice == null);
                text("delivery-help", "After you finish a normal recording, Moss retrieves it and creates a Meeting automatically. Uploads retry when your connection returns.", 13, false);
                text("delivery-state", choices.enabled() ? "Enabled · " + state.optString("activity", "starting").replace('_', ' ') : "Stopped · recordings remain on the ring", 13, false);
                if (!choices.recovery().isEmpty()) text("recovery", choices.recovery(), 13, false);
                rule("delivery-rule");
                toggle("hold", "Hold-to-talk in Main chat", voice != null && voice.optBoolean("desired"), enabled -> command(enabled ? "voice-on" : "voice-off"));
                text("hold-help", "Review each new hold transcript in Moss, then press Send for a text reply. Existing recordings keep their destination.", 13, false);
                text("hold-state", voice == null ? "Off" : voice.has("disableId") ? "Turning off" : voice.has("snapshot") ? "Saving enrollment" :
                    voice.has("enablement") ? "Enrollment saved" : voice.optBoolean("desired") ? "Waiting for stable ring inventory" : "Off", 13, false);
                rule("hold-rule");
                toggle("reminder", "Remind me after an hour", choices.recordingReminder(), enabled -> choices.recordingReminder(enabled));
                text("reminder-help", "An optional phone notification after the same recording has been observed for an hour. Requires delivery, notifications and ring status. Gaps in observation or restarting Moss reset the timer. It never stops recording.", 13, false);
                rule("reminder-rule");
                row("storage", "Ring storage", "Capacity and saved recordings", () -> show("storage"));
                row("phone", "Phone audio", "Delivered copies and automatic cleanup", () -> show("phone"));
                row("connection", "Connection & permissions", "Bluetooth, background delivery and account recovery", () -> show("connection"));
                row("guide", "How to use your ring", "Recording, bookmarks and hold-to-talk", () -> show("guide"));
                row("about", "About this ring", "Ring identity and installed firmware", () -> show("about"));
                row("diagnostics", "Delivery details", "Recent Meetings, voice requests and troubleshooting", this::diagnostics);
                break;
            case "storage":
                text("title", "Ring storage", 30, true);
                JSONObject storage = snapshot.optJSONObject("storage");
                if (storage == null) text("unknown", "Storage unavailable. A status check runs during automatic delivery.", 15, false);
                else {
                    text("free", bytes(storage.optLong("free")) + " free of " + bytes(storage.optLong("total")), 20, true);
                    text("used", bytes(storage.optLong("used")) + " used · " + observed(storage.optLong("at")), 13, false);
                }
                if (snapshot.has("recordings")) text("count", snapshot.optInt("recordings") + " supported audio files on ring · " + observed(snapshot.optLong("inventoryAt")), 15, false);
                text("keep", "Delivery keeps recordings on your ring. Phone audio cleanup affects only copies on this phone.", 15, false);
                text("management", "Individual recording management is not available in this build.", 13, false);
                break;
            case "phone":
                text("title", "Phone audio", 30, true);
                JSONObject entries = state.optJSONObject("entries");
                text("usage", phoneStorage(entries), 15, false);
                toggle("cleanup", "Clear delivered audio after 7 days", choices.autoCleanup(), enabled -> choices.autoCleanup(enabled));
                text("cleanup-help", "Cleanup runs while delivery is active. Pending, failed and interrupted recordings stay here. Moss and ring copies are kept.", 13, false);
                button("clear", "Clear completed phone audio", () -> new android.app.AlertDialog.Builder(this).setTitle("Clear completed phone audio?")
                    .setMessage("Remove completed delivery audio from this phone. Pending and failed audio, Moss copies and ring recordings are kept.")
                    .setNegativeButton("Keep audio", null).setPositiveButton("Clear phone copies", (dialog, which) -> command("clear-completed")).show());
                break;
            case "connection":
                text("title", "Connection & permissions", 30, true);
                text("permission-state", "Nearby devices: " + (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed") +
                    "\nNotifications: " + (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed"), 15, false);
                button("permissions", "Allow Bluetooth and notifications", () -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1));
                PowerManager power = getSystemService(PowerManager.class);
                text("background", power.isIgnoringBatteryOptimizations(getPackageName()) ? "Battery use: unrestricted" : "Allow Unrestricted battery use in Android settings and remove Moss from Samsung Sleeping apps.", 15, false);
                button("app-settings", "Open Android app settings", () -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getPackageName()))));
                text("restart", "Automatic delivery resumes after restart when Android permits. After Force stop, open Moss and turn Automatic delivery on again.", 13, false);
                if (getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, DeliveryService.OFFICIAL) == PackageManager.PERMISSION_GRANTED) {
                    text("handoff", "Vocci has Nearby devices access. Remove that permission before using Moss for delivery; restore it when switching back.", 15, false);
                    button("official-settings", "Open Vocci app settings", () -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + DeliveryService.OFFICIAL))));
                }
                button("account", "Moss account and recovery", this::diagnostics);
                button("setup", "Ring setup", () -> startActivity(new Intent(this, SetupActivity.class)));
                break;
            case "guide":
                text("title", "How to use your ring", 30, true);
                text("record-title", "Record a Meeting", 20, true);
                text("record-help", "Double-click the ring button to start recording. Double-click again to finish. With Automatic delivery on, completed recordings become Meetings when the ring and phone reconnect.", 15, false);
                rule("record-rule"); text("bookmark-title", "Mark a moment", 20, true);
                text("bookmark-help", "During a normal recording, click once to add a bookmark. Moss keeps bookmark times with the Meeting.", 15, false);
                rule("bookmark-rule"); text("hold-title", "Send a voice message", 20, true);
                text("hold-help", "Enable Hold-to-talk first. Hold the button while speaking, then release. In Moss, review the transcript and choose Send to Main. Moss replies with text.", 15, false);
                rule("hold-rule"); text("offline-title", "Away from your phone", 20, true);
                text("offline-help", "The ring saves audio locally. Leave Bluetooth and background delivery enabled on the phone for retrieval when they reconnect. Turning off delivery does not stop a recording on the ring.", 15, false);
                break;
            case "about":
                text("title", "About this ring", 30, true);
                text("identity", config == null ? "Saved setup unavailable. Use Ring setup to recover." : "Vocci ring\nSerial: " + config.optString("sn"), 15, false);
                JSONObject info = snapshot.optJSONObject("info");
                text("firmware", info == null ? "Firmware not checked yet" : "Firmware " + info.optString("firmware") + "\nHardware " + info.optString("hardware") +
                    (info.optString("model").isEmpty() ? "" : "\nModel " + info.optString("model")) + "\n" + observed(info.optLong("at")), 15, false);
                text("updates", "Firmware updating is not available in Moss yet.", 13, false);
                break;
            default: page = "hardware"; handler.post(this::render);
        }
        for (String key : new ArrayList<>(views.keySet())) if (!used.contains(key)) body.removeView(views.remove(key));
        if (restoreY != null) {
            int y = restoreY; restoreY = null;
            scroll.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                @Override public void onGlobalLayout() { scroll.getViewTreeObserver().removeOnGlobalLayoutListener(this); scroll.scrollTo(0, y); }
            }); body.requestLayout();
        }
    }
}
