package ai.moss.vocci;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.drawable.ColorDrawable;
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
    private boolean updatingSwitch;
    private Integer restoreScrollY;
    private final Runnable refresh = new Runnable() {
        @Override public void run() { render(); handler.postDelayed(this, 3000); }
    };
    @Override public void onCreate(Bundle state) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(state);
        if ("stop".equals(getIntent().getAction())) stopService(new Intent(this, DeliveryService.class));
        theme = new NativeTheme(this); getWindow().setBackgroundDrawable(new ColorDrawable(theme.paper));
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().getDecorView().getWindowInsetsController().setSystemBarsAppearance(theme.dark ? 0 :
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        scroll = new ScrollView(this); scroll.setBackgroundColor(theme.paper); scroll.setFillViewport(true);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(theme.dp(24), theme.dp(24), theme.dp(24), theme.dp(32));
        scroll.addView(body); setContentView(scroll); scroll.requestApplyInsets();
        if (state != null) restoreScrollY = state.getInt("scrollY");
    }
    @Override public void onSaveInstanceState(Bundle state) { state.putInt("scrollY", scroll.getScrollY()); super.onSaveInstanceState(state); }
    @Override public void onResume() { super.onResume(); handler.post(refresh); }
    @Override public void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
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
    private void section(String key, String number, String title) {
        View rule = place(key + "/rule", View.class, () -> new View(this), 24); rule.setBackgroundColor(theme.line);
        rule.getLayoutParams().height = theme.dp(1);
        TextView eyebrow = place(key + "/number", TextView.class, () -> theme.eyebrow(), 16); NativeTheme.update(eyebrow, number + " / " + title.toUpperCase(Locale.ROOT));
        text(key + "/title", title, 24, true);
    }
    private void button(String key, String label, Runnable action) {
        Button button = place(key, Button.class, () -> theme.button(action, key.equals("start")), position > 0 && body.getChildAt(position - 1) instanceof Button ? 8 : 12);
        NativeTheme.update(button, label);
        // Destination/status closures may change while the view and its focus remain stable.
        button.setOnClickListener(v -> action.run());
    }
    private void command(String action) {
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1); return;
        }
        startForegroundService(new Intent(this, DeliveryService.class).setAction(action));
        Toast.makeText(this, "Change queued", Toast.LENGTH_SHORT).show();
    }
    private void open(String origin, String path) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(origin + path))); }
        catch (ActivityNotFoundException unavailable) { Toast.makeText(this, "Install a browser to open Moss", Toast.LENGTH_SHORT).show(); }
    }
    private void render() {
        position = 0; used.clear();
        NativeTheme.update(place("masthead", TextView.class, () -> theme.eyebrow(), 0), "MOSS / RING COMPANION");
        text("title", "Vocci → Moss", 32, true);
        TextView intro = place("intro", TextView.class, () -> theme.text(15, false), 12); intro.setTextColor(theme.text);
        NativeTheme.update(intro, "Normal recordings become meetings. Hold-to-talk goes to Main chat, with text replies.");
        section("connection", "01", "Connection");
        button("start", "Start delivery", () -> command("start"));
        button("stop", "Stop delivery", () -> stopService(new Intent(this, DeliveryService.class)));
        button("permissions", "Bluetooth and notification permissions", () -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1));
        text("permission-status", "Bluetooth: " + (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed") +
            " · Notifications: " + (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed"), 13, false);
        JSONObject config = null;
        try {
            config = new SecretStore(this).load();
            text("identity", "Moss: " + config.getString("origin") + "\nAccount: " + config.getString("ownerId") + "\nRing: " + config.getString("sn"), 13, false);
        } catch (Exception unavailable) {
            text("identity", "Setup needed: provision your existing ring binding and Moss session using the developer setup instructions, then Start delivery.", 13, false);
        }
        try {
            JSONObject state = PrivateFiles.json(new File(getNoBackupFilesDir(), "delivery/state.json")); // Never construct DeliveryStore: it writes.
            text("activity", "Status: " + state.optString("activity", "stopped").replace('_', ' '), 17, false);
            section("voice", "02", "Voice messages");
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
            section("storage", "03", "Local audio");
            text("storage-usage", DeliveryStatus.storage(new File(getNoBackupFilesDir(), "delivery"), state.getJSONObject("entries")), 13, false);
            button("clear", "Clear completed local audio", () -> command("clear-completed"));
            section("recent", "04", "Recent deliveries");
            JSONObject entries = state.getJSONObject("entries"); List<String> ids = new ArrayList<>(); entries.keys().forEachRemaining(ids::add);
            ids.sort(Collections.reverseOrder());
            if (ids.isEmpty()) text("empty", "No recordings yet. Start delivery and finish a recording on the ring.", 15, false);
            final JSONObject destination = config;
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
                    if (entry.has("voiceIntent") && status.optString("state").equals("failed") && status.optBoolean("retryable"))
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
