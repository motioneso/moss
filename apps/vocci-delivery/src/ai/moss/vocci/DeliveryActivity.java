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
    private boolean updatingSwitch, connectionDetails;
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
        if ("stop".equals(getIntent().getAction())) stopDelivery();
        if (!new SecretStore(this).exists()) {
            startActivity(new Intent(this, SetupActivity.class)); finish(); return;
        }
        theme = new NativeTheme(this); theme.window();
        scroll = new ScrollView(this); scroll.setBackgroundColor(theme.paper); scroll.setFillViewport(true);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(24), theme.dp(24), theme.dp(32));
        scroll.addView(body); setContentView(scroll); scroll.requestApplyInsets();
        if (state != null) { restoreScrollY = state.getInt("scrollY"); connectionDetails = state.getBoolean("connectionDetails"); }
    }
    @Override public void onSaveInstanceState(Bundle state) { if (scroll != null) state.putInt("scrollY", scroll.getScrollY()); state.putBoolean("connectionDetails", connectionDetails); super.onSaveInstanceState(state); }
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
                else if (action.equals("disconnect")) { link.disconnect(); status = "Disconnected. Ring binding and queued recordings are kept."; }
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
        Button button = place(key, Button.class, () -> theme.button(action, key.equals("start")), position > 0 && body.getChildAt(position - 1) instanceof Button ? 8 : 12);
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
    private void render() {
        position = 0; used.clear();
        NativeTheme.update(place("masthead", TextView.class, () -> theme.eyebrow(), 0), "HARDWARE / VOCCI RING");
        text("title", "Delivery details", 30, true);
        button("hardware", "‹ Hardware", () -> {
            startActivity(new Intent(this, HardwareActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)); finish();
        });
        TextView intro = place("intro", TextView.class, () -> theme.text(15, false), 12); intro.setTextColor(theme.text);
        NativeTheme.update(intro, "Recent recordings and connection help.");
        section("connection", "Connection");
        button("start", "Start delivery", () -> command("start"));
        button("stop", "Stop delivery", this::stopDelivery);
        DeliveryPreferences choices = new DeliveryPreferences(this);
        JSONObject config = null;
        try {
            config = new SecretStore(this).load();
            text("identity", "Moss: " + config.getString("origin") + "\nAccount: " + config.optString("accountName", config.getString("ownerId")) + "\nRing: " + config.getString("sn"), 13, false);
            text("account-status", config.has("credential") ? "Account connected · device approval" : config.has("cookie") ? "Developer session · connect in browser for daily use" : "Account disconnected · connect in browser to resume", 15, false);
            button("setup-options", "Ring setup and delivery options", () -> startActivity(new Intent(this, SetupActivity.class)));
            button("connect-account", new MossLink(this).pending() ? "Reopen browser approval" : "Connect Moss in browser", () -> link("begin"));
            if (new MossLink(this).pending()) button("cancel-link", "Cancel connection request", () -> link("cancel"));
            if (config.has("credential")) button("disconnect-account", "Disconnect Moss account", () -> link("disconnect"));
            text("account-help", "Use the same Moss account that owns this queue. Your browser handles sign-in; ring setup and pending recordings are kept when reconnecting.", 13, false);
            if (!linkStatus.isEmpty()) text("link-status", linkStatus, 15, false);
        } catch (Exception unavailable) {
            text("identity", "Saved setup could not be opened. Your existing account and queued recordings are kept. Restore the original setup before starting delivery.", 13, false);
        }
        text("restart-status", choices.enabled() ? "Delivery enabled · resumes after phone restart when Android permits." : "Delivery stopped · automatic restart is off.", 13, false);
        if (!choices.recovery().isEmpty()) text("recovery", choices.recovery(), 15, false);
        button("connection-details", connectionDetails ? "Hide connection settings" : "Permissions and background settings", () -> { connectionDetails = !connectionDetails; render(); });
        if (connectionDetails) {
            button("permissions", "Bluetooth and notification permissions", () -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1));
            text("permission-status", "Bluetooth: " + (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed") +
                " · Notifications: " + (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed"), 13, false);
            text("background-help", "After Force stop, open this app and Start delivery. Keep Bluetooth on and allow background battery use for dependable delivery.", 13, false);
            android.os.PowerManager power = getSystemService(android.os.PowerManager.class);
            text("battery-status", power.isIgnoringBatteryOptimizations(getPackageName()) ? "Battery optimization: unrestricted" : "Battery optimization is active. In App settings → Battery, choose Unrestricted; also remove Moss from Samsung Sleeping apps.", 13, false);
            button("app-settings", "Open companion app settings", () -> appSettings(getPackageName()));
            if (getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, DeliveryService.OFFICIAL) == PackageManager.PERMISSION_GRANTED) {
                text("handoff-help", "Vocci still has Nearby devices access. Remove that permission before starting Moss; restore it when switching back to Vocci.", 13, false);
                button("vocci-settings", "Open Vocci app settings", () -> appSettings(DeliveryService.OFFICIAL));
            }
        }
        try {
            JSONObject state = PrivateFiles.json(new File(getNoBackupFilesDir(), "delivery/state.json")); // Never construct DeliveryStore: it writes.
            text("activity", "Status: " + state.optString("activity", "stopped").replace('_', ' '), 17, false);
            section("voice", "Voice messages");
            JSONObject voice = state.optJSONObject("voice");
            Switch enabled = place("voice-switch", Switch.class, () -> {
                Switch view = new Switch(this); theme.toggle(view); view.setText("Hold-to-talk in Main chat");
                view.setOnCheckedChangeListener((v, checked) -> { if (!updatingSwitch) command(checked ? "voice-on" : "voice-off"); }); return view;
            }, 12);
            updatingSwitch = true;
            try { enabled.setChecked(voice != null && voice.optBoolean("desired")); }
            finally { updatingSwitch = false; }
            enabled.setEnabled(config != null);
            text("voice-help", "Enable after the ring inventory is checked twice. Existing recordings keep their destination. Until capture timing is observed, review the transcript and press Send in Moss.", 13, false);
            text("enrollment", voice == null ? "Voice input off" : voice.has("disableId") ? "Voice disable pending" : voice.has("snapshot") ? "Saving voice enrollment" : voice.has("enablement") ? "Voice enrollment saved" : voice.optBoolean("desired") ? "Waiting for stable ring inventory" : "Voice input off", 15, false);
            section("storage", "Local audio");
            text("storage-usage", DeliveryStatus.storage(new File(getNoBackupFilesDir(), "delivery"), state.getJSONObject("entries")), 13, false);
            Switch cleanup = place("cleanup-switch", Switch.class, () -> {
                Switch view = new Switch(this); theme.toggle(view); view.setText("Clear delivered audio after 7 days");
                view.setOnCheckedChangeListener((v, checked) -> { if (!updatingSwitch) new DeliveryPreferences(this).autoCleanup(checked); }); return view;
            }, 12);
            updatingSwitch = true;
            try { cleanup.setChecked(choices.autoCleanup()); } finally { updatingSwitch = false; }
            text("cleanup-help", "Optional cleanup runs while delivery is active. Pending, failed and interrupted recordings stay here. Moss copies and recordings on the ring are kept.", 13, false);
            button("clear", "Clear completed local audio", () -> command("clear-completed"));
            section("recent", "Recent deliveries");
            JSONObject entries = state.getJSONObject("entries"); List<String> ids = new ArrayList<>(); entries.keys().forEachRemaining(ids::add);
            ids.sort(Collections.reverseOrder());
            if (ids.isEmpty()) text("empty", "No recordings yet. Start delivery and finish a recording on the ring.", 15, false);
            final JSONObject destination = config;
            JSONObject recordings = config == null ? new JSONObject() : RingRecordings.read(this, config, state.optString("sourceDeviceId"));
            JSONObject exclusions = recordings.optJSONObject("exclusions");
            for (String id : ids.subList(0, Math.min(30, ids.size()))) {
                JSONObject entry = entries.getJSONObject(id), status = entry.optJSONObject("status"), chat = entry.optJSONObject("chatStatus");
                String stage = chat == null ? entry.getString("stage") : chat.getString("state");
                text(id + "/title", entry.has("voiceIntent") ? "Main chat" : "Meeting", 20, true);
                text(id + "/detail", id + "\n" + stage.replace('-', ' ') + (entry.optBoolean("cleared") ? " · local audio cleared" : "") +
                    (entry.has("error") ? "\n" + entry.getString("error").replace('_', ' ') : ""), 13, false);
                String upload = DeliveryStatus.upload(new File(new File(getNoBackupFilesDir(), "delivery"), id), entry);
                if (!upload.isEmpty()) text(id + "/upload", upload, 13, false);
                if (chat != null) text(id + "/chat", chat.optString("statusMessage"), 15, false);
                if (destination != null && status != null) {
                    if (entry.has("voiceIntent") && !status.isNull("voiceRequestId")) {
                        String requestId = MossClient.uuid(status.getString("voiceRequestId"));
                        button(id + "/open", "Review in Moss", () -> open(destination.optString("origin"), "/?voiceRequest=" + requestId));
                    } else if (!entry.has("voiceIntent")) {
                        String meetingId = MossClient.uuid(status.getString("meetingId"));
                        button(id + "/open", "Open meeting", () -> open(destination.optString("origin"), "/meetings?id=" + meetingId));
                    }
                    if (DeliveryService.retryTranscriptionAllowed(entry, exclusions != null && exclusions.has(id)))
                        button(id + "/retry", "Retry transcription", () -> startForegroundService(new Intent(this, DeliveryService.class).setAction("retry-transcription").putExtra("recordingId", id)));
                }
            }
        } catch (Exception unavailable) { text("snapshot-error", "No delivery snapshot available. Start delivery to initialize the queue.", 15, false); }
        for (String key : new ArrayList<>(views.keySet())) if (!used.contains(key)) body.removeView(views.remove(key));
        // The first layout may precede the posted snapshot render. Restore only
        // once the populated content has been measured, otherwise ScrollView clamps to zero.
        if (restoreScrollY != null) {
            final int savedY = restoreScrollY; restoreScrollY = null;
            scroll.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                @Override public void onGlobalLayout() {
                    scroll.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                    scroll.scrollTo(0, savedY);
                }
            });
            body.requestLayout();
        }
    }
}
