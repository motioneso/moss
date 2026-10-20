package ai.moss.vocci;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

public final class DeliveryService extends Service {
    static final String OFFICIAL = "com.gygeslabs.odinclient";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile RingConnection active;
    private volatile boolean stopping;
    private volatile boolean started;
    private DeliveryStore store;
    private PowerManager.WakeLock wake;
    private final Map<String, Integer> previous = new HashMap<>();
    private int reconnectAttempts;
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("delivery", "Recording delivery", NotificationManager.IMPORTANCE_LOW));
        startForeground(3550, notification("Starting recording delivery"));
    }
    private Notification notification(String text) {
        Intent stop = new Intent(this, DeliveryService.class).setAction("stop");
        PendingIntent action = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "delivery").setContentTitle("Moss recording delivery").setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop", action).build()).build();
    }
    private void report(String code) throws Exception {
        store.activity(code);
        int complete = 0, failed = 0;
        for (String id : store.ids()) {
            String stage = store.entries.getJSONObject(id).getString("stage");
            if (stage.equals("complete")) complete++;
            if (stage.equals("failed")) failed++;
        }
        getSystemService(NotificationManager.class).notify(3550, notification(code.replace('_', ' ') + " · " + complete + " complete · " + failed + " failed"));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (!started) { started = true; worker.submit(this::run); }
        return START_STICKY;
    }
    private void run() {
        try {
            store = new DeliveryStore(this);
            SecretStore secrets = new SecretStore(this);
            secrets.provision(this);
            JSONObject config = secrets.load();
            MossClient client = new MossClient(config);
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "moss:vocci-delivery");
            while (!stopping && !Thread.currentThread().isInterrupted()) {
                if (getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, OFFICIAL) == PackageManager.PERMISSION_GRANTED) {
                    report("handoff_required"); break;
                }
                try {
                    wake.acquire(240000);
                    // Verify the credential's current owner before touching queued recordings.
                    if (!client.owner().equals(config.getString("ownerId"))) { report("owner_mismatch"); break; }
                    deliver(client);
                    if (reconnectAttempts < RetryPolicy.MAX_ATTEMPTS && store.capacity()) {
                        retrieve(config);
                        reconnectAttempts = 0;
                        deliver(client);
                    } else if (!store.capacity()) report("storage_capacity");
                    else report("reconnect_exhausted");
                } catch (MossClient.Rejected error) {
                    report(error.status == 401 || error.status == 403 ? "session_refresh_required" : "server_unavailable");
                    if (error.terminal()) break;
                    reconnectAttempts++;
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); break; }
                catch (Exception error) {
                    String message = error.getMessage();
                    Set<String> safe = new HashSet<>(Arrays.asList("ring_connect", "ring_mtu", "ring_services", "ring_subscribe", "ring_identity", "ring_challenge", "ring_start_app", "inventory_limit", "gatt_timeout_or_error", "transfer start", "incomplete", "unexpected file bytes"));
                    store.state.put("lastFailure", safe.contains(message) ? message : error.getClass().getSimpleName());
                    reconnectAttempts = Math.min(reconnectAttempts + 1, RetryPolicy.MAX_ATTEMPTS);
                    report(reconnectAttempts >= RetryPolicy.MAX_ATTEMPTS ? "reconnect_exhausted" : "retry_pending");
                } finally {
                    if (active != null) { active.close(); active = null; }
                    if (wake.isHeld()) wake.release();
                }
                long delay = reconnectAttempts == 0 ? 30000 : RetryPolicy.delayMs(Math.min(reconnectAttempts, RetryPolicy.MAX_ATTEMPTS));
                Thread.sleep(delay);
            }
        } catch (Exception error) {
            if (store != null) try { report("configuration_or_storage_required"); } catch (Exception ignored) { /* No private exception detail is logged. */ }
        } finally {
            if (active != null) active.close();
            if (wake != null && wake.isHeld()) wake.release();
            started = false;
        }
    }
    private void retrieve(JSONObject config) throws Exception {
        report("retrieving");
        active = new RingConnection(this, config);
        try {
            Map<String, Integer> inventory = active.inventory();
            for (Map.Entry<String, Integer> file : inventory.entrySet()) {
                String name = file.getKey();
                if (!name.endsWith(".opus")) continue;
                String id = name.substring(0, name.length() - 5), sidecarName = id + ".json";
                Integer sidecarSize = inventory.get(sidecarName);
                if (store.contains(id) || sidecarSize == null || file.getValue() > RingProtocol.PACKET_LIMIT || sidecarSize > RingProtocol.SIDECAR_LIMIT ||
                    !file.getValue().equals(previous.get(name)) || !sidecarSize.equals(previous.get(sidecarName))) continue;
                if (!store.capacity() || stopping) break;
                byte[] sidecar = active.retrieve(sidecarName, sidecarSize);
                if (!completed(sidecar)) continue;
                byte[] packets = active.retrieve(name, file.getValue());
                RingProtocol.packetCount(packets);
                store.retrieved(id, packets, sidecar);
            }
            previous.clear(); previous.putAll(inventory);
        } finally { active.close(); active = null; }
        report("waiting_for_completed_recordings");
    }
    static boolean completed(byte[] sidecar) throws Exception {
        JSONArray rows = new JSONArray("[" + new String(sidecar, StandardCharsets.UTF_8) + "]");
        boolean end = false, duration = false;
        for (int n = 0; n < rows.length(); n++) {
            JSONObject row = rows.getJSONObject(n);
            JSONArray record = row.optJSONArray("record"), time = row.optJSONArray("duration");
            if (record != null && record.length() >= 2 && "end".equals(record.optString(1))) end = true;
            if (time != null && time.length() >= 2 && time.optDouble(1, -1) > 0 && time.optDouble(1, -1) <= 120000) duration = true;
        }
        return end && duration;
    }
    private void deliver(MossClient client) throws Exception {
        for (String id : store.ids()) {
            if (stopping || Thread.currentThread().isInterrupted()) return;
            JSONObject entry = store.entries.getJSONObject(id);
            String stage = entry.getString("stage");
            if (stage.equals("complete") || stage.equals("failed") ||
                !RetryPolicy.due(entry.optInt("attempts"), entry.optLong("nextAt"), System.currentTimeMillis())) continue;
            report("delivering");
            try {
                if (stage.equals("retrieved")) { store.freeze(id); stage = "ready"; }
                store.beginAttempt(id);
                JSONObject status = stage.equals("accepted") ? client.poll(entry.getJSONObject("status").getString("id")) :
                    client.accept(PrivateFiles.read(store.file(id, "bundle.json"), 8 * 1024 * 1024));
                store.accepted(id, status);
            } catch (MossClient.Rejected error) {
                if (error.status == 401 || error.status == 403) {
                    entry.remove("inFlight"); entry.put("attempts", Math.max(0, entry.optInt("attempts") - 1)); store.save();
                    throw error;
                }
                store.failure(id, "http_" + error.status, error.terminal());
            } catch (IllegalArgumentException error) { store.failure(id, "decode_or_input_invalid", true); }
            catch (Exception error) { store.failure(id, "transfer_retry", false); }
        }
    }
    @Override public void onDestroy() {
        stopping = true;
        if (active != null) active.close();
        worker.shutdownNow();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
