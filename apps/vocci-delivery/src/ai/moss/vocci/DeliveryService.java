package ai.moss.vocci;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import java.io.File;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

public final class DeliveryService extends Service {
    static final String OFFICIAL = "com.gygeslabs.odinclient";
    private static final Set<String> SAFE_FAILURES = new HashSet<>(Arrays.asList("ring_connect", "ring_mtu", "ring_services", "ring_subscribe", "ring_identity", "ring_challenge", "ring_start_app", "inventory_limit", "gatt_timeout_or_error", "transfer start", "incomplete", "unexpected file bytes"));
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile RingConnection active;
    private volatile boolean stopping;
    private volatile boolean started;
    private DeliveryStore store;
    private VoiceDelivery voice;
    private final Queue<Intent> commands = new ConcurrentLinkedQueue<>();
    private final Object signal = new Object();
    private PowerManager.WakeLock wake;
    private final Map<String, Integer> previousInventory = new HashMap<>();
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
            .setContentIntent(PendingIntent.getActivity(this, 2, new Intent(this, DeliveryActivity.class), PendingIntent.FLAG_IMMUTABLE))
            .setSmallIcon(android.R.drawable.stat_sys_upload).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop", action).build()).build();
    }
    private synchronized void report(String code) throws Exception {
        if (stopping) return;
        store.activity(code);
        int complete = 0, failed = 0, pending = 0;
        for (String id : store.ids()) {
            String stage = store.entries.getJSONObject(id).getString("stage");
            if (DeliveryStore.completed(stage)) complete++;
            if (stage.equals("failed")) failed++;
            if (!DeliveryStore.completed(stage) && !stage.equals("failed") && !stage.equals("interrupted")) pending++;
        }
        getSystemService(NotificationManager.class).notify(3550, notification(code.replace('_', ' ') + " · " + complete + " complete · " + failed + " failed · " + pending + " pending"));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        if (intent != null && Arrays.asList("voice-on", "voice-off", "clear-completed", "retry-transcription").contains(intent.getAction())) commands.add(new Intent(intent));
        synchronized (signal) { signal.notifyAll(); }
        if (!started) { started = true; worker.submit(this::run); }
        return START_STICKY;
    }
    private void run() {
        try {
            store = new DeliveryStore(this); voice = new VoiceDelivery(store);
            SecretStore secrets = new SecretStore(this);
            secrets.provision(this);
            JSONObject config = secrets.load();
            MossClient client = new MossClient(config);
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "moss:vocci-delivery");
            while (!stopping && !Thread.currentThread().isInterrupted()) {
                try {
                    wake.acquire(4 * 60 * 60 * 1000L);
                    // Verify the credential's current owner before touching queued recordings.
                    if (!client.owner().equals(config.getString("ownerId"))) { report("owner_mismatch"); break; }
                    consumeCommands(client); voice.synchronize(client);
                    if (getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, OFFICIAL) == PackageManager.PERMISSION_GRANTED) {
                        report("handoff_required"); break;
                    }
                    deliver(client);
                    if (store.hasStorageCapacity()) {
                        retrieve(config, client);
                        reconnectAttempts = 0;
                        deliver(client);
                    } else report("storage_capacity");
                } catch (MossClient.Rejected error) {
                    report(error.status == 401 || error.status == 403 ? "session_refresh_required" : error.terminal() ? "server_rejected" : "server_unavailable");
                    if (error.terminal()) break;
                    reconnectAttempts = RetryPolicy.connectionFailure(reconnectAttempts);
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); break; }
                catch (Exception error) {
                    if (stopping || Thread.currentThread().isInterrupted()) break;
                    String message = error.getMessage();
                    store.state.put("lastFailure", SAFE_FAILURES.contains(message) ? message : error.getClass().getSimpleName());
                    reconnectAttempts = RetryPolicy.connectionFailure(reconnectAttempts);
                    report("retry_pending");
                } finally {
                    if (active != null) { active.close(); active = null; }
                    if (wake.isHeld()) wake.release();
                }
                if (stopping || Thread.currentThread().isInterrupted()) break;
                synchronized (signal) { if (commands.isEmpty() && !stopping) signal.wait(RetryPolicy.connectionDelayMs(reconnectAttempts)); }
            }
        } catch (InterruptedException error) { Thread.currentThread().interrupt();
        } catch (Exception error) {
            if (!stopping && store != null) try { report("configuration_or_storage_required"); } catch (Exception ignored) { /* No private exception detail is logged. */ }
        } finally {
            if (active != null) active.close();
            if (wake != null && wake.isHeld()) wake.release();
            if (stopping && store != null) try { store.activity("stopped"); } catch (Exception ignored) { /* Preserve private failures. */ }
            started = false;
        }
    }
    private void retrieve(JSONObject config, MossClient client) throws Exception {
        report("retrieving");
        active = new RingConnection(this, config);
        try {
            Map<String, Integer> inventory = active.inventory();
            voice.inventory(inventory, client);
            for (String name : store.retrievalOrder(inventory.keySet())) {
                Integer packetSize = inventory.get(name);
                String id = name.substring(0, name.length() - 5), sidecarName = id + ".json";
                Integer sidecarSize = inventory.get(sidecarName);
                if (!store.retrievalDue(id) || sidecarSize == null ||
                    !packetSize.equals(previousInventory.get(name)) || !sidecarSize.equals(previousInventory.get(sidecarName))) continue;
                if (!store.hasStorageCapacity() || stopping) break;
                if (!store.contains(id) && !store.canDiscover()) continue;
                store.discover(id, voice.intent(id));
                if (packetSize > RingProtocol.PACKET_LIMIT || sidecarSize > RingProtocol.SIDECAR_LIMIT) {
                    store.failure(id, "source_size_limit", true); continue;
                }
                byte[] sidecar;
                try { sidecar = active.retrieve(sidecarName, sidecarSize); }
                catch (IllegalArgumentException invalid) { store.failure(id, "ring_file_invalid", false); throw invalid; }
                if (!store.admitSidecar(id, sidecar)) continue;
                store.reserveRetrieval(id, packetSize, sidecarSize, sidecar);
                try { active.retrieve(name, packetSize, store.file(id, "packets.bin")); }
                catch (IllegalArgumentException invalid) { store.failure(id, "ring_file_invalid", false); throw invalid; }
                store.retrieved(id, sidecar);
            }
            previousInventory.clear(); previousInventory.putAll(inventory);
        } finally { active.close(); active = null; }
        report(store.canDiscover() ? "waiting_for_completed_recordings" : "storage_capacity");
    }
    private void deliver(MossClient client) throws Exception {
        for (String id : store.ids()) {
            if (stopping || Thread.currentThread().isInterrupted()) return;
            JSONObject entry = store.entries.getJSONObject(id);
            String stage = entry.getString("stage");
            if (stage.equals("discovered") || DeliveryStore.completed(stage) || stage.equals("failed") || stage.equals("interrupted") ||
                !RetryPolicy.due(entry.optInt("attempts"), entry.optLong("nextAt"), System.currentTimeMillis())) continue;
            report("delivering");
            try {
                if (stage.equals("retrieved")) { store.freeze(id); stage = "ready"; }
                store.beginAttempt(id);
                if (stage.equals("voice-status")) {
                    store.chatStatus(id, client.chat(entry.getJSONObject("status").getString("voiceRequestId")));
                } else {
                    boolean voice = entry.has("voiceIntent");
                    JSONObject status = stage.equals("accepted") ? (voice ? client.pollVoice(entry.getJSONObject("status").getString("id")) : client.poll(entry.getJSONObject("status").getString("id"))) :
                        (store.file(id, "upload.json").exists() ? ResumableUpload.deliver(client, store, id) :
                          (voice ? client.acceptVoice(PrivateFiles.read(store.file(id, "bundle.json"), 8 * 1024 * 1024)) : client.accept(PrivateFiles.read(store.file(id, "bundle.json"), 8 * 1024 * 1024))));
                    store.accepted(id, status);
                }
            } catch (MossClient.Rejected error) {
                if (stopping) throw new InterruptedException();
                if (error.status == 401 || error.status == 403) {
                    store.abandonAttempt(id);
                    throw error;
                }
                store.httpFailure(id, error.status, error.terminal());
            } catch (DeliveryStore.Conflict error) { store.failure(id, error.getMessage(), true); }
            catch (InterruptedException error) { throw error; }
            catch (IllegalArgumentException error) { store.failure(id, "decode_or_input_invalid", true); }
            catch (Exception error) {
                if (stopping || Thread.currentThread().isInterrupted()) throw new InterruptedException();
                store.failure(id, "transfer_retry", false);
            }
        }
    }
    private void consumeCommands(MossClient client) throws Exception {
        Intent command;
        while ((command = commands.peek()) != null) {
            String action = command.getAction();
            if (action.equals("voice-on") || action.equals("voice-off")) voice.desired(action.equals("voice-on"));
            else if (action.equals("clear-completed")) store.clearCompleted();
            else if (action.equals("retry-transcription")) {
                String id = command.getStringExtra("recordingId");
                JSONObject entry = store.entries.optJSONObject(id == null ? "" : id);
                if (entry != null && entry.has("voiceIntent") && entry.has("status") &&
                    entry.getJSONObject("status").getString("state").equals("failed") && entry.getJSONObject("status").optBoolean("retryable"))
                    store.accepted(id, client.retryVoice(entry.getJSONObject("status").getString("id")));
            }
            commands.remove();
        }
    }
    @Override public synchronized void onDestroy() {
        stopping = true;
        synchronized (signal) { signal.notifyAll(); }
        worker.shutdownNow();
        if (active != null) active.close();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
