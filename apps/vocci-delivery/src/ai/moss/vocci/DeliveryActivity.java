package ai.moss.vocci;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.widget.*;
import java.io.File;
import java.util.*;
import org.json.JSONObject;

/** Read-only status snapshots; all queue changes belong to the service worker. */
public final class DeliveryActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private LinearLayout body;
    private final Runnable refresh = new Runnable() {
        @Override public void run() { render(); handler.postDelayed(this, 3000); }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if ("stop".equals(getIntent().getAction())) stopService(new Intent(this, DeliveryService.class));
        ScrollView scroll = new ScrollView(this); body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density); body.setPadding(pad, pad, pad, pad);
        scroll.addView(body); setContentView(scroll);
    }
    @Override public void onResume() { super.onResume(); handler.post(refresh); }
    @Override public void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
    private void text(String value, boolean heading) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(heading ? 21 : 15);
        view.setPadding(0, 12, 0, 12); body.addView(view);
    }
    private void button(String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setOnClickListener(v -> action.run()); body.addView(button);
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
        body.removeAllViews(); text("Vocci → Moss", true);
        text("Normal recordings become meetings. Hold-to-talk goes to Main chat, with text replies.", false);
        button("Start delivery", () -> command("start"));
        button("Stop delivery", () -> stopService(new Intent(this, DeliveryService.class)));
        button("Bluetooth and notification permissions", () -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS}, 1));
        text("Bluetooth: " + (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed") +
            " · Notifications: " + (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ? "allowed" : "needed"), false);
        JSONObject config = null;
        try {
            config = new SecretStore(this).load();
            text("Moss: " + config.getString("origin") + "\nAccount: " + config.getString("ownerId") + "\nRing: " + config.getString("sn"), false);
        } catch (Exception unavailable) {
            text("Setup needed: provision your existing ring binding and Moss session using the developer setup instructions, then Start delivery.", false);
        }
        try {
            File file = new File(getNoBackupFilesDir(), "delivery/state.json");
            JSONObject state = PrivateFiles.json(file); // Never construct DeliveryStore here: it writes.
            text("Status: " + state.optString("activity", "stopped").replace('_', ' '), false);
            JSONObject voice = state.optJSONObject("voice");
            Switch enabled = new Switch(this); enabled.setText("Hold-to-talk in Main chat");
            enabled.setChecked(voice != null && voice.optBoolean("desired")); enabled.setEnabled(config != null);
            enabled.setOnCheckedChangeListener((v, checked) -> command(checked ? "voice-on" : "voice-off")); body.addView(enabled);
            text("Enable after the ring inventory is checked twice. Existing recordings keep their destination. Until capture timing is observed, review the transcript and press Send in Moss.", false);
            if (voice != null) text(voice.has("disableId") ? "Voice disable pending" : voice.has("snapshot") ? "Saving voice enrollment" : voice.has("enablement") ? "Voice enrollment saved" : voice.optBoolean("desired") ? "Waiting for stable ring inventory" : "Voice input off", false);
            button("Clear completed local audio", () -> command("clear-completed"));
            text("Recent deliveries", true);
            JSONObject entries = state.getJSONObject("entries"); List<String> ids = new ArrayList<>(); entries.keys().forEachRemaining(ids::add);
            ids.sort(Collections.reverseOrder());
            if (ids.isEmpty()) text("No recordings yet. Start delivery and finish a recording on the ring.", false);
            final JSONObject destination = config;
            for (String id : ids.subList(0, Math.min(30, ids.size()))) {
                JSONObject entry = entries.getJSONObject(id), status = entry.optJSONObject("status"), chat = entry.optJSONObject("chatStatus");
                String stage = chat == null ? entry.getString("stage") : chat.getString("state");
                text(id + "\n" + (entry.has("voiceIntent") ? "Main chat" : "Meeting") + " · " + stage.replace('-', ' ') +
                    (entry.optBoolean("cleared") ? " · local audio cleared" : "") + (entry.has("error") ? "\n" + entry.getString("error").replace('_', ' ') : ""), false);
                if (chat != null) text(chat.optString("statusMessage"), false);
                if (destination != null && status != null) {
                    if (entry.has("voiceIntent") && !status.isNull("voiceRequestId")) {
                        String requestId = MossClient.uuid(status.getString("voiceRequestId"));
                        button("Review in Moss", () -> open(destination.optString("origin"), "/?voiceRequest=" + requestId));
                    } else if (!entry.has("voiceIntent")) {
                        String meetingId = MossClient.uuid(status.getString("meetingId"));
                        button("Open meeting", () -> open(destination.optString("origin"), "/meetings?id=" + meetingId));
                    }
                    if (entry.has("voiceIntent") && status.optString("state").equals("failed") && status.optBoolean("retryable"))
                        button("Retry transcription", () -> startForegroundService(new Intent(this, DeliveryService.class).setAction("retry-transcription").putExtra("recordingId", id)));
                }
            }
        } catch (Exception unavailable) { text("No delivery snapshot available. Start delivery to initialize the queue.", false); }
    }
}
