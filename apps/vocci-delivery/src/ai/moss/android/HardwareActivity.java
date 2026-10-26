package ai.moss.android;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import android.text.format.DateUtils;
import android.view.*;
import android.widget.*;
import java.io.File;
import java.util.*;
import java.util.function.Supplier;
import org.json.JSONObject;

/** Native ring settings and saved ring inspection. Opening starts no delivery. */
public final class HardwareActivity extends Activity {
    private NativeTheme theme;
    private LinearLayout body;
    private ScrollView scroll;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, View> views = new LinkedHashMap<>();
    private final Set<String> used = new HashSet<>();
    private String page = "storage";
    private int position;
    private boolean updating;
    private Integer restoreY;
    private String selectedId = "", pendingRecordingRequest = "";
    private long pendingRecordingAt;
    private int recordingPage;
    private final Runnable refresh = new Runnable() {
        @Override public void run() { render(); handler.postDelayed(this, 3000); }
    };
    @Override public void onCreate(Bundle saved) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(saved);
        String requested = getIntent().getStringExtra("page");
        if (saved == null && requested == null) {
            Intent home = new Intent(this, DeliveryActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (getIntent().hasExtra(ReminderDismissal.WINDOW)) home.putExtra(ReminderDismissal.WINDOW, getIntent().getLongExtra(ReminderDismissal.WINDOW, 0));
            startActivity(home); finish(); return;
        }
        theme = new NativeTheme(this); theme.window();
        scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(theme.paper);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(12), theme.dp(24), theme.dp(32)); scroll.addView(body);
        setContentView(scroll); scroll.requestApplyInsets();
        if (requested != null) page = requested;
        if (saved == null) { RecordingReminder.SHARED.dismiss(getIntent().getLongExtra(ReminderDismissal.WINDOW, 0)); getIntent().removeExtra(ReminderDismissal.WINDOW); }
        if (saved != null) {
            page = saved.getString("page", "storage"); restoreY = saved.getInt("scrollY");
            selectedId = saved.getString("selectedId", ""); recordingPage = saved.getInt("recordingPage");
            pendingRecordingRequest = saved.getString("recordingRequest", ""); pendingRecordingAt = saved.getLong("recordingAt");
        }
    }
    @Override public void onResume() { super.onResume(); if (body != null) handler.post(refresh); }
    @Override public void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
    @Override public void onSaveInstanceState(Bundle saved) {
        saved.putString("page", page); if (scroll != null) saved.putInt("scrollY", scroll.getScrollY()); super.onSaveInstanceState(saved);
        saved.putString("selectedId", selectedId); saved.putInt("recordingPage", recordingPage);
        saved.putString("recordingRequest", pendingRecordingRequest); saved.putLong("recordingAt", pendingRecordingAt);
    }
    @Override public void onBackPressed() {
        home();
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
        Button button = place(key, Button.class, () -> theme.button(action, key.equals("clear") || key.equals("refresh") || key.equals("exclude")), 12);
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
    private void home() { startActivity(new Intent(this, DeliveryActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)); finish(); }
    private JSONObject delivery() {
        try { return PrivateFiles.json(new File(getNoBackupFilesDir(), "delivery/state.json")); }
        catch (Exception unavailable) { return new JSONObject(); }
    }
    private String permissionStatus() {
        return checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ? "All allowed" : "Permission needed";
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
    private String recording(JSONObject snapshot) {
        JSONObject state = snapshot.optJSONObject("recording");
        return field(snapshot, "recording", HardwareStatus.recordingLabel(state == null ? "" : state.optString("state")));
    }
    private static String bytes(long size) { return String.format(Locale.getDefault(), "%.1f MiB", size / 1048576.0); }
    private void recordingCommand(Intent intent) {
        if (!new SecretStore(this).exists()) { Toast.makeText(this, "Recover your saved setup first.", Toast.LENGTH_LONG).show(); return; }
        if ("inspect-ring".equals(intent.getAction()) && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, 1); return;
        }
        String request = UUID.randomUUID().toString(); intent.putExtra("requestId", request);
        try {
            if (startForegroundService(intent) == null) throw new IllegalStateException();
            pendingRecordingRequest = request; pendingRecordingAt = System.currentTimeMillis();
        } catch (IllegalStateException | SecurityException unavailable) {
            Toast.makeText(this, "Change not confirmed. Review Android background permissions and retry.", Toast.LENGTH_LONG).show();
        }
        render();
    }
    private boolean recordingReceipt(JSONObject snapshot) {
        if (pendingRecordingRequest.isEmpty()) return false;
        JSONObject receipt = snapshot.optJSONObject("command");
        if (receipt != null && pendingRecordingRequest.equals(receipt.optString("id"))) {
            String result = receipt.optString("result");
            text("command-result", result.equals("excluded") ? "Exclusion saved. Further delivery for this source is blocked." :
                result.equals("refreshed") ? "Saved recordings refreshed." : result.equals("handoff_required") ? "Refresh blocked. Remove Vocci’s Nearby devices access in Connection & permissions, then retry." :
                result.equals("source_changed") ? "Source changed. Refresh and select the recording again; exclusion was not saved." :
                result.equals("exclusion_limit") ? "Exclusion storage is full. No exclusion was saved." : "Request failed. Keep the ring nearby, check Connection & permissions and retry.", 13, false);
            return false;
        }
        boolean pending = System.currentTimeMillis() - pendingRecordingAt < 30000;
        text("command-result", pending ? "Request pending. A current transfer may finish first; exclusion is not saved until confirmed here." :
            "Request not confirmed. Refresh or retry; no saved exclusion is being claimed.", 13, false);
        return pending;
    }
    private void recordings(JSONObject snapshot) {
        JSONObject sources = snapshot.optJSONObject("sources");
        if (sources == null) { text("inventory-unknown", "Saved recordings have not been checked. Refresh to inspect the ring without starting delivery.", 15, false); return; }
        text("inventory-time", observed(snapshot.optLong("inventoryAt")) + " · saved observation, may be stale", 13, false);
        List<String> ids = new ArrayList<>(); sources.keys().forEachRemaining(ids::add); Collections.sort(ids);
        if (ids.isEmpty()) { text("empty", "No supported audio sources in the last ring inventory.", 15, false); return; }
        int pages = (ids.size() + 24) / 25; recordingPage = Math.max(0, Math.min(recordingPage, pages - 1));
        text("list-page", "Saved recordings · page " + (recordingPage + 1) + " of " + pages, 15, false);
        for (int n = recordingPage * 25; n < Math.min(ids.size(), (recordingPage + 1) * 25); n++) {
            String id = ids.get(n);
            boolean excluded = snapshot.optJSONObject("exclusions") != null && snapshot.optJSONObject("exclusions").has(id);
            row("source-" + id, id, excluded ? "Excluded from further delivery" : (id.startsWith("amsg_") ? "Hold audio source" : "Normal audio source") + " · inspect", () -> { selectedId = id; show("recording"); });
        }
        if (recordingPage > 0) button("previous", "Previous recordings", () -> { recordingPage--; render(); scroll.scrollTo(0, 0); });
        if (recordingPage + 1 < pages) button("next", "More recordings", () -> { recordingPage++; render(); scroll.scrollTo(0, 0); });
    }
    private void inspectRecording(JSONObject snapshot, JSONObject delivery, boolean pending) {
        text("title", "Recording on ring", 30, true); text("source", selectedId, 20, true);
        JSONObject sources = snapshot.optJSONObject("sources"), item = sources == null ? null : sources.optJSONObject(selectedId);
        if (item == null) { text("missing", "This source is absent from the latest saved inventory. Refresh Ring storage before selecting it again.", 15, false); return; }
        text("observation", observed(snapshot.optLong("inventoryAt")) + " · ring presence may be stale", 13, false);
        text("size", "Advertised audio: " + item.optInt("audioBytes") + " bytes\n" + (item.isNull("sidecarBytes") ? "No matching sidecar listed" : "Advertised metadata: " + item.optInt("sidecarBytes") + " bytes"), 15, false);
        text("metadata", RecordingDetails.metadata(new File(getNoBackupFilesDir(), "delivery"), selectedId), 15, false);
        JSONObject entries = delivery.optJSONObject("entries"), entry = entries == null ? null : entries.optJSONObject(selectedId);
        text("delivery", RecordingDetails.delivery(entry), 15, false);
        text("destination", entry != null && entry.has("voiceIntent") ? "Destination stays Main chat · transcript review and Send remain required." : "Normal delivery creates a Meeting. Hold destinations depend on saved enrollment; exclusion never changes consent.", 13, false);
        boolean excluded = snapshot.optJSONObject("exclusions") != null && snapshot.optJSONObject("exclusions").has(selectedId);
        if (excluded) text("excluded", "Excluded from further delivery. Ring recordings, phone evidence and any existing Moss item are kept.", 15, false);
        else {
            button("exclude", "Exclude from delivery", () -> {
                final String id = selectedId, scope = snapshot.optString("scope"), selection = RingRecordings.selection(snapshot, id);
                new android.app.AlertDialog.Builder(this).setTitle("Exclude this recording?")
                    .setMessage(id + "\n\nSave an exclusion for this ring and account. Ring files and phone evidence stay. A current transfer may finish before this is saved. Bytes already sent, existing Meetings and Main chat items cannot be recalled. This build has no undo.")
                    .setNegativeButton("Keep delivery", null).setPositiveButton("Exclude recording", (dialog, which) -> recordingCommand(new Intent(this, DeliveryService.class).setAction("exclude-recording")
                        .putExtra("scope", scope).putExtra("recordingId", id).putExtra("selection", selection))).show();
            });
            views.get(page + "/exclude").setEnabled(!pending);
        }
        text("delete", "Deleting recordings from this ring is not available in this build. Your recordings stay on the ring.", 13, false);
    }
    private void render() {
        position = 0; used.clear();
        DeliveryPreferences choices = new DeliveryPreferences(this);
        JSONObject config = null;
        try { config = new SecretStore(this).load(); } catch (Exception unavailable) { /* Show setup/recovery, keep existing data. */ }
        final JSONObject snapshot = config == null ? new JSONObject() : HardwareStatus.read(this, config);
        final JSONObject state = delivery(), voice = state.optJSONObject("voice");
        final JSONObject recordings = config == null ? new JSONObject() : RingRecordings.read(this, config, state.optString("sourceDeviceId"));
        button("back", "‹ Hardware", this::onBackPressed);
        NativeTheme.update(place("eyebrow", TextView.class, () -> theme.eyebrow(), 12), "HARDWARE");
        switch (page) {
            case "hardware": case "ring": case "settings": home(); break;
            case "storage":
                text("title", "Recordings on ring", 30, true);
                JSONObject storage = snapshot.optJSONObject("storage");
                if (storage == null) text("unknown", "Storage unavailable. A status check runs during automatic delivery.", 15, false);
                else {
                    text("free", bytes(storage.optLong("free")) + " free of " + bytes(storage.optLong("total")), 20, true);
                    text("used", bytes(storage.optLong("used")) + " used · " + observed(storage.optLong("at")), 13, false);
                }
                if (snapshot.has("recordings")) text("count", snapshot.optInt("recordings") + " supported audio files on ring · " + observed(snapshot.optLong("inventoryAt")), 15, false);
                text("keep", "Delivery keeps recordings on your ring. Phone audio cleanup affects only copies on this phone.", 15, false);
                boolean pending = recordingReceipt(recordings);
                button("refresh", "Refresh saved recordings", () -> recordingCommand(new Intent(this, DeliveryService.class).setAction("inspect-ring")));
                views.get(page + "/refresh").setEnabled(!pending);
                recordings(recordings);
                text("management", "Inspect a source to exclude further delivery. Ring deletion is unavailable in this build.", 13, false);
                break;
            case "recording":
                boolean exclusionPending = recordingReceipt(recordings);
                inspectRecording(recordings, state, exclusionPending);
                break;
            case "phone":
                text("title", "Clear delivered audio", 30, true);
                JSONObject entries = state.optJSONObject("entries");
                text("usage", phoneStorage(entries), 15, false);
                toggle("cleanup", "Clear delivered audio after 7 days", choices.autoCleanup(), enabled -> choices.autoCleanup(enabled));
                text("cleanup-help", "Cleanup runs while delivery is active. Pending, failed and interrupted recordings stay here. Moss and ring copies are kept.", 13, false);
                button("clear", "Clear delivered audio", () -> new android.app.AlertDialog.Builder(this).setTitle("Clear completed phone audio?")
                    .setMessage("Remove completed delivery audio from this phone. Pending and failed audio, Moss copies and ring recordings are kept.")
                    .setNegativeButton("Keep audio", null).setPositiveButton("Clear phone copies", (dialog, which) -> command("clear-completed")).show());
                views.get(page + "/clear").setEnabled(choices.enabled() && state.optJSONObject("entries") != null);
                break;
            case "connection":
                text("title", "Permissions and battery", 30, true);
                text("permission-state", "Nearby devices: " + (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed") +
                    "\nNotifications: " + (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed"), 15, false);
                if (!permissionStatus().equals("All allowed")) button("permissions", "Allow Bluetooth and notifications", () -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1));
                PowerManager power = getSystemService(PowerManager.class);
                text("background", power.isIgnoringBatteryOptimizations(getPackageName()) ? "Battery use: unrestricted" : "Allow Unrestricted battery use in Android settings and remove Moss from Samsung Sleeping apps.", 15, false);
                button("app-settings", "Open Android app settings", () -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getPackageName()))));
                text("restart", "Automatic delivery resumes after restart when Android permits. After Force stop, open Moss and choose Start delivery on Home.", 13, false);
                if (getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, DeliveryService.OFFICIAL) == PackageManager.PERMISSION_GRANTED) {
                    text("handoff", "Vocci has Nearby devices access. Remove that permission before using Moss for delivery; restore it when switching back.", 15, false);
                    button("official-settings", "Open Vocci app settings", () -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + DeliveryService.OFFICIAL))));
                }
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
                rule("feedback-rule"); text("feedback-title", "Ring lights and vibration", 20, true);
                text("feedback-help", "Light and vibration meanings have not been verified for this ring in Moss. Check the dated recording status in Vocci ring settings. A delivered recording appears as a Meeting or a hold transcript for review; a vibration alone does not confirm delivery.", 15, false);
                break;
            case "about":
                text("title", "About this ring", 30, true);
                text("identity", config == null ? "Saved setup unavailable. Use Ring setup to recover." : "Vocci ring\nSerial: " + config.optString("sn"), 15, false);
                JSONObject info = snapshot.optJSONObject("info");
                text("recording", recording(snapshot), 15, false);
                text("firmware", info == null ? "Firmware not checked yet" : "Firmware " + info.optString("firmware") + "\nHardware " + info.optString("hardware") +
                    (info.optString("model").isEmpty() ? "" : "\nModel " + info.optString("model")) + "\n" + observed(info.optLong("at")), 15, false);
                text("updates", "Firmware updating is not available in Moss yet.", 13, false);
                break;
            default: home();
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
