package ai.moss.vocci;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.widget.*;
import java.io.File;
import java.util.*;
import java.util.function.Supplier;
import org.json.JSONObject;

/** Read-only snapshots; stable keyed controls preserve taps, scrolling and focus across polls. */
public final class DeliveryActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private LinearLayout body;
    private ScrollView scroll;
    private NativeTheme theme;
    private final Map<String, View> views = new LinkedHashMap<>();
    private final Set<String> used = new HashSet<>();
    private int position;
    private String selectedId = "";
    private Integer restoreScrollY;
    private final java.util.concurrent.ExecutorService linking = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final java.util.concurrent.atomic.AtomicBoolean linkBusy = new java.util.concurrent.atomic.AtomicBoolean();
    private String linkStatus = "";
    private final Runnable refresh = new Runnable() {
        @Override public void run() { render(); if (new MossLink(DeliveryActivity.this).pending()) link("check"); handler.postDelayed(this, 3000); }
    };
    @Override public void onCreate(Bundle state) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(state);
        if (state == null) { RecordingReminder.SHARED.dismiss(getIntent().getLongExtra(ReminderDismissal.WINDOW, 0)); getIntent().removeExtra(ReminderDismissal.WINDOW); }
        if ("stop".equals(getIntent().getAction())) stopDelivery();
        theme = new NativeTheme(this); theme.window();
        scroll = new ScrollView(this); scroll.setBackgroundColor(theme.paper); scroll.setFillViewport(true);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(24), theme.dp(24), theme.dp(32));
        scroll.addView(body); setContentView(scroll); scroll.requestApplyInsets();
        if (state != null) { restoreScrollY = state.getInt("scrollY"); selectedId = state.getString("selectedId", ""); }
    }
    @Override public void onSaveInstanceState(Bundle state) { if (scroll != null) state.putInt("scrollY", scroll.getScrollY()); state.putString("selectedId", selectedId); super.onSaveInstanceState(state); }
    @Override public void onResume() { super.onResume(); if (body != null) handler.post(refresh); }
    @Override public void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
    @Override public void onDestroy() { linking.shutdownNow(); super.onDestroy(); }
    private void link(String action) {
        if (!linkBusy.compareAndSet(false, true)) return;
        if (!action.equals("check")) stopDelivery();
        linking.submit(() -> {
            String status; String path = null;
            try {
                MossLink link = new MossLink(this);
                if (action.equals("begin")) { path = link.begin(); status = "Approve this phone in your browser, then return here. Delivery stays stopped until you press Start."; }
                else if (action.equals("cancel")) { link.cancel(); status = "Connection request cancelled."; }
                else status = link.check() ? "Connected to Moss. Press Start delivery when ready." : "Waiting for browser approval…";
            } catch (Exception error) {
                if (error instanceof MossClient.Rejected) {
                    int code = ((MossClient.Rejected) error).status;
                    status = code == 409 ? "Approval was already redeemed. Cancel this request and connect again to recover safely." :
                        code == 403 ? "Request declined or account unavailable. Cancel and connect again with your original Moss account." :
                        code == 410 || code == 404 ? "Connection request expired. Cancel it and connect again." : "Moss is unavailable. Check your connection and try again.";
                } else if ("configuration_identity_change".equals(error.getMessage()) || "owner_mismatch".equals(error.getMessage()))
                    status = "This ring’s queue belongs to another account. Connect using the original Moss account; nothing was moved.";
                else if ("link_expired".equals(error.getMessage())) status = "Connection request expired. Cancel it and connect again.";
                else status = "Connection could not finish. Check your network, then try again; your ring and queue are kept.";
            }
            final String message = status, approval = path;
            handler.post(() -> {
                linkBusy.set(false);
                if (isDestroyed()) return;
                linkStatus = message;
                if (approval != null) try { open(new SecretStore(this).load().getString("origin"), approval); }
                catch (Exception unavailable) { linkStatus = "Could not open Moss. Try Connect in browser again."; }
                render();
            });
        });
    }
    private <T extends View> T place(String key, Class<T> type, Supplier<T> create, int gap) {
        View view = views.get(key);
        if (view == null) { view = create.get(); views.put(key, view); }
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
    private void section(String key, String title) {
        View rule = place(key + "/rule", View.class, () -> new View(this), 24); rule.setBackgroundColor(theme.line);
        rule.getLayoutParams().height = theme.dp(1);
        text(key + "/title", title, 24, true);
    }
    private void button(String key, String label, Runnable action) {
        Button button = place(key, Button.class, () -> theme.button(action, key.endsWith("/open") || key.endsWith("/retry")), position > 0 && body.getChildAt(position - 1) instanceof Button ? 8 : 12);
        NativeTheme.update(button, label);
        // Destination/status closures may change while the view and its focus remain stable.
        button.setOnClickListener(v -> action.run());
    }
    private void command(String action) {
        Toast.makeText(this, DeliveryActions.command(this, action), Toast.LENGTH_LONG).show(); render();
    }
    private void open(String origin, String path) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(origin + path))); }
        catch (ActivityNotFoundException unavailable) { Toast.makeText(this, "Install a browser to open Moss", Toast.LENGTH_SHORT).show(); }
    }
    private void stopDelivery() {
        DeliveryActions.stop(this);
    }
    private void appSettings(String packageName) {
        try { startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName))); }
        catch (ActivityNotFoundException unavailable) { Toast.makeText(this, "Open Apps in Android settings", Toast.LENGTH_SHORT).show(); }
    }
    @Override public void onBackPressed() {
        if (!selectedId.isEmpty()) { selectedId = ""; render(); scroll.scrollTo(0, 0); }
        else super.onBackPressed();
    }
    private void settings(String page) {
        startActivity(new Intent(this, HardwareActivity.class).putExtra("page", page));
    }
    private JSONObject snapshot() {
        try { return PrivateFiles.json(new File(getNoBackupFilesDir(), "delivery/state.json")); }
        catch (Exception unavailable) { return new JSONObject(); }
    }
    private void row(String key, String title, String detail, Runnable action) {
        place(key, SettingsRow.class, () -> new SettingsRow(theme), 0).update(title, detail, action);
        View line = place(key + "/rule", View.class, () -> new View(this), 0);
        line.setBackgroundColor(theme.line); line.getLayoutParams().height = theme.dp(1);
    }
    private void home(JSONObject config, JSONObject state) {
        text("title", "Vocci ring", 30, true);
        DeliveryPreferences choices = new DeliveryPreferences(this);
        HomeStatus.Setup setup = config != null ? HomeStatus.Setup.READY :
            new SecretStore(this).exists() ? HomeStatus.Setup.UNREADABLE :
            new File(getNoBackupFilesDir(), "delivery/state.json").exists() ? HomeStatus.Setup.RECOVERY : HomeStatus.Setup.NEEDED;
        if (setup == HomeStatus.Setup.READY) try { VocciBindings.selected(config); }
        catch (Exception recovery) { setup = HomeStatus.Setup.RECOVERY; }
        boolean permissions = checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        PowerManager power = getSystemService(PowerManager.class);
        String activity = state.optString("activity");
        boolean connected = config != null && config.has("credential");
        if (connected && config.has("credentialExpiresAt")) try {
            connected = java.time.Instant.parse(config.getString("credentialExpiresAt")).isAfter(java.time.Instant.now());
        } catch (Exception invalidExpiry) { connected = false; }
        HomeStatus.Card card = HomeStatus.choose(setup, connected, new MossLink(this).pending(),
            getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, DeliveryService.OFFICIAL) == PackageManager.PERMISSION_GRANTED,
            permissions, power == null || !power.isIgnoringBatteryOptimizations(getPackageName()), choices.enabled(), choices.recovery());
        String detail = config == null ? setup == HomeStatus.Setup.UNREADABLE ?
            "Saved setup could not be opened. Your existing account and queued recordings are kept. Restore the original setup before starting delivery." :
            "Connect the ring you already own. Your recordings are kept." :
            "Ring " + config.optString("sn") + " · " + config.optString("accountName", config.optString("ownerId")) + " on " + config.optString("origin");
        if (card.action == HomeStatus.Action.VOCCI_SETTINGS) detail = "Remove the Vocci app’s Nearby devices access.\n" + detail;
        else if (choices.enabled() && card.action == HomeStatus.Action.STOP) detail = progress(activity) + "\n" + detail;
        HomeStatusCard view = place("status-card", HomeStatusCard.class, () -> new HomeStatusCard(theme), 16);
        view.update(card, detail, () -> {
            switch (card.action) {
                case SETUP: startActivity(new Intent(this, SetupActivity.class)); break;
                case CONNECT: case APPROVAL: link("begin"); break;
                case VOCCI_SETTINGS: appSettings(DeliveryService.OFFICIAL); break;
                case PERMISSIONS: requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1); break;
                case APP_SETTINGS: appSettings(getPackageName()); break;
                case START: command("start"); break;
                case STOP: stopDelivery(); render(); break;
                default: break;
            }
        }, () -> link("cancel"));
        view.busy(linkBusy.get());
        if (!linkStatus.isEmpty()) text("link-status", linkStatus, 15, false);
        JSONObject entries = state.optJSONObject("entries");
        if (entries != null && entries.length() > 0) {
            section("recent", "Recent");
            List<String> ids = new ArrayList<>(); entries.keys().forEachRemaining(ids::add);
            ids.sort((a, b) -> Long.compare(recordingTime(b), recordingTime(a)));
            for (String id : ids.subList(0, Math.min(3, ids.size()))) {
                JSONObject entry = entries.optJSONObject(id); if (entry == null) continue;
                String time = recordingTime(id) == 0 ? "Time unavailable" : android.text.format.DateUtils.formatDateTime(this, recordingTime(id),
                    android.text.format.DateUtils.FORMAT_SHOW_DATE | android.text.format.DateUtils.FORMAT_SHOW_TIME);
                row("recent/" + id, time + " · " + outcome(entry),
                    (entry.has("voiceIntent") ? "Voice message" : "Meeting") + " · " + length(id),
                    () -> { selectedId = id; render(); scroll.scrollTo(0, 0); });
            }
            if (ids.size() > 3) row("history", "All deliveries", "", () -> { selectedId = "history"; render(); scroll.scrollTo(0, 0); });
        }
        row("recordings", "Recordings on ring", "", () -> settings("storage"));
        row("settings", "Settings", "", () -> settings("settings"));
    }
    private static long recordingTime(String id) {
        try { String stamp = id.startsWith("amsg_") ? id.substring(5) : id; return Long.parseLong(stamp.substring(0, 10)) * 1000; }
        catch (RuntimeException invalid) { return 0; }
    }
    private String length(String id) {
        if (!RingProtocol.validName(id + ".opus")) return "Length unavailable";
        try {
            long ms = CompletedSidecar.duration(PrivateFiles.read(new File(new File(getNoBackupFilesDir(), "delivery/" + id), "sidecar.bin"), RingProtocol.SIDECAR_LIMIT), Long.MAX_VALUE);
            if (ms <= 0) return "Length unavailable";
            long seconds = (ms + 999) / 1000;
            return seconds < 60 ? seconds + " sec" : (seconds / 60) + " min " + (seconds % 60) + " sec";
        } catch (Exception unavailable) { return "Length unavailable"; }
    }
    private static String progress(String activity) {
        switch (activity) {
            case "waiting_for_completed_recordings": case "listening": case "idle": return "Waiting for the next finished recording.";
            case "retrieving": return "Bringing a recording onto your phone.";
            case "uploading": return "Sending a recording to Moss.";
            default: return activity.isEmpty() ? "Waiting for the next finished recording." : activity.replace('_', ' ');
        }
    }
    private static String outcome(JSONObject entry) {
        if (entry == null) return "Status unavailable";
        JSONObject chat = entry.optJSONObject("chatStatus"), status = entry.optJSONObject("status");
        String stage = chat != null ? chat.optString("state") : status != null ? status.optString("state", entry.optString("stage")) : entry.optString("stage");
        return stage.replace('-', ' ').replace('_', ' ');
    }
    private void recording(JSONObject config, JSONObject state) {
        button("back", "‹ Vocci ring", this::onBackPressed);
        JSONObject entries = state.optJSONObject("entries");
        if (selectedId.equals("history")) {
            text("history-title", "All deliveries", 30, true);
            if (entries != null) {
                List<String> ids = new ArrayList<>(); entries.keys().forEachRemaining(ids::add); ids.sort((a, b) -> Long.compare(recordingTime(b), recordingTime(a)));
                for (String id : ids.subList(0, Math.min(30, ids.size()))) row("history/" + id, id, outcome(entries.optJSONObject(id)),
                    () -> { selectedId = id; render(); scroll.scrollTo(0, 0); });
            }
            return;
        }
        JSONObject entry = entries == null ? null : entries.optJSONObject(selectedId);
        text("recording-title", entry != null && entry.has("voiceIntent") ? "Voice message" : "Meeting", 30, true);
        if (entry == null) { text("missing", "This delivery is no longer in the saved snapshot.", 15, false); return; }
        final String id = selectedId;
        text("recording-id", id, 15, false);
        text("recording-state", RecordingDetails.delivery(entry), 15, false);
        text("recording-length", length(id), 15, false);
        try {
            String upload = DeliveryStatus.upload(new File(getNoBackupFilesDir(), "delivery/" + id), entry);
            if (!upload.isEmpty()) text("upload", upload, 13, false);
        } catch (Exception unavailable) { text("upload", "Upload progress unavailable.", 13, false); }
        JSONObject chat = entry.optJSONObject("chatStatus"), status = entry.optJSONObject("status");
        if (chat != null) text("chat", chat.optString("statusMessage"), 15, false);
        if (config != null && status != null) try {
            JSONObject sources = RingRecordings.read(this, config, state.optString("sourceDeviceId"));
            JSONObject exclusions = sources.optJSONObject("exclusions");
            boolean retry = DeliveryService.retryTranscriptionAllowed(entry, exclusions != null && exclusions.has(id));
            String path = null;
            if (entry.has("voiceIntent") && !status.isNull("voiceRequestId"))
                path = "/?voiceRequest=" + MossClient.uuid(status.getString("voiceRequestId"));
            else if (!entry.has("voiceIntent")) path = "/meetings?id=" + MossClient.uuid(status.getString("meetingId"));
            final String destination = path;
            if (retry && new DeliveryPreferences(this).enabled()) {
                button("recording/retry", "Retry transcription", () -> startForegroundService(new Intent(this, DeliveryService.class).setAction("retry-transcription").putExtra("recordingId", id)));
                if (destination != null) row("review", entry.has("voiceIntent") ? "Review in Moss" : "Open meeting", "", () -> open(config.optString("origin"), destination));
            } else if (destination != null) {
                button("recording/open", entry.has("voiceIntent") ? "Review in Moss" : "Open meeting", () -> open(config.optString("origin"), destination));
                if (retry) text("retry-stopped", "Start delivery on Home to retry transcription.", 13, false);
            }
        } catch (Exception unavailable) { text("destination-error", "Moss destination is unavailable in this snapshot.", 13, false); }
    }
    private void render() {
        position = 0; used.clear();
        NativeTheme.update(place("masthead", TextView.class, () -> theme.eyebrow(), 0), "MOSS / VOCCI RING");
        JSONObject config = null;
        try { config = new SecretStore(this).load(); } catch (Exception unavailable) { /* Present recovery without replacing data. */ }
        JSONObject state = snapshot();
        if (selectedId.isEmpty()) home(config, state); else recording(config, state);
        for (String key : new ArrayList<>(views.keySet())) if (!used.contains(key)) body.removeView(views.remove(key));
        if (restoreScrollY != null) {
            final int savedY = restoreScrollY; restoreScrollY = null;
            scroll.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                @Override public void onGlobalLayout() {
                    scroll.getViewTreeObserver().removeOnGlobalLayoutListener(this); scroll.scrollTo(0, savedY);
                }
            }); body.requestLayout();
        }
    }
}
