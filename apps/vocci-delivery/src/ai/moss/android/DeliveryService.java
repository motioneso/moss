package ai.moss.android;

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
    // Hold-to-talk keeps one ring link open and listens for the end of a press; fastRetries re-checks the ring soon after a press.
    private boolean keepOpen;
    private int fastRetries, admitRetries;
    private final RecordingReminder reminder = RecordingReminder.SHARED;
    private int latestStartId;
    interface RetryVoice { JSONObject retry(String statusId) throws Exception; }
    private static final class OwnerMismatch extends Exception { }
    static boolean recordingCommand(String action) { return "inspect-ring".equals(action) || "exclude-recording".equals(action); }
    static boolean retryTranscriptionAllowed(JSONObject entry, boolean excluded) {
        JSONObject status = entry == null ? null : entry.optJSONObject("status");
        return !excluded && entry != null && entry.has("voiceIntent") && status != null &&
            status.optString("state").equals("failed") && status.optBoolean("retryable");
    }
    static boolean retryTranscription(DeliveryStore store, String recordingId, RetryVoice retry) throws Exception {
        String id = recordingId == null ? "" : recordingId;
        JSONObject entry = store.entries.optJSONObject(id);
        if (!retryTranscriptionAllowed(entry, store.excluded(id))) return false;
        store.accepted(id, retry.retry(entry.getJSONObject("status").getString("id")));
        return true;
    }
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("delivery", "Recording delivery", NotificationManager.IMPORTANCE_LOW));

        // Channel importance is fixed at creation, so the heads-up alert needs a new channel id.
        manager.deleteNotificationChannel("recording-reminder");
        NotificationChannel reminders = new NotificationChannel("recording-reminder-alert", "Long recordings", NotificationManager.IMPORTANCE_HIGH);
        reminders.enableVibration(true);
        manager.createNotificationChannel(reminders);
        startForeground(3550, notification("Working with your ring"));
    }
    private Notification notification(String text) {
        Intent stop = new Intent(this, DeliveryService.class).setAction("stop");
        PendingIntent action = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "delivery").setContentTitle("Moss recording delivery").setContentText(text)
            .setContentIntent(PendingIntent.getActivity(this, 2, new Intent(this, HardwareActivity.class), PendingIntent.FLAG_IMMUTABLE))
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
        RingProblemNotifier.sync(this);
    }
    @Override public synchronized int onStartCommand(Intent intent, int flags, int startId) {
        latestStartId = startId;
        DeliveryPreferences choices = new DeliveryPreferences(this);
        String action = intent == null ? null : intent.getAction();
        boolean enabled = choices.applyAction(action);
        if (!enabled && !recordingCommand(action)) { stopSelf(); return START_NOT_STICKY; }
        if (intent != null && (recordingCommand(action) || Arrays.asList("voice-on", "voice-off", "clear-completed", "retry-transcription").contains(action))) commands.add(new Intent(intent));
        synchronized (signal) { signal.notifyAll(); }
        if (!started) { started = true; worker.submit(this::run); }
        return enabled ? START_STICKY : START_NOT_STICKY;
    }
    private void run() {
        boolean initialized = false;
        try {
            store = new DeliveryStore(this); voice = new VoiceDelivery(store);
            SecretStore secrets = new SecretStore(this);
            secrets.provision(this);
            JSONObject config = secrets.load();
            MossClient client = new MossClient(config);
            store.recordings = new RingRecordings(this, config, store.state.getString("sourceDeviceId"));
            store.boundary = () -> consumeCommands(client, config);
            initialized = true;
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "moss:vocci-delivery");
            while (!stopping && !Thread.currentThread().isInterrupted()) {
                try {
                    keepOpen = false;
                    wake.acquire(4 * 60 * 60 * 1000L);
                    consumeCommands(client, config);
                    if (!new DeliveryPreferences(this).enabled()) break;
                    // Verify the credential's current owner before touching queued recordings.
                    if (!client.owner().equals(config.getString("ownerId"))) { report("owner_mismatch"); break; }
                    voice.synchronize(client);
                    if (new DeliveryPreferences(this).autoCleanup()) store.clearExpiredCompleted(System.currentTimeMillis());
                    if (getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, OFFICIAL) == PackageManager.PERMISSION_GRANTED) {
                        report("handoff_required"); break;
                    }
                    deliver(client);
                    if (store.hasStorageCapacity()) {
                        retrieve(config, client);
                        reconnectAttempts = 0;
                        deliver(client);
                        keepOpen = voice.active() && active != null && !stopping;
                    } else report("storage_capacity");
                } catch (OwnerMismatch error) { report("owner_mismatch"); break;
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
                    if (active != null && !keepOpen) { active.close(); active = null; }
                    if (wake.isHeld()) wake.release();
                }
                if (stopping || Thread.currentThread().isInterrupted()) break;
                long lostLinkWait = 0;
                if (keepOpen && active != null) {
                    try {
                        boolean pressed = active.listen(fastRetries > 0 ? 1500 : 60_000, () -> !commands.isEmpty() || stopping);
                        if (pressed) { fastRetries = 5; admitRetries = 0; } else if (fastRetries > 0) fastRetries--;
                        continue;
                    } catch (java.io.IOException lost) { active.close(); active = null; lostLinkWait = 3000; }
                }
                if (lostLinkWait > 0) { synchronized (signal) { if (commands.isEmpty() && !stopping) signal.wait(lostLinkWait); } continue; }
                synchronized (signal) { if (commands.isEmpty() && !stopping) signal.wait(RetryPolicy.connectionDelayMs(reconnectAttempts)); }
            }
        } catch (InterruptedException error) { Thread.currentThread().interrupt();
        } catch (Exception error) {
            if (!stopping && store != null) try { report("configuration_or_storage_required"); } catch (Exception ignored) { /* No private exception detail is logged. */ }
        } finally {
            if (active != null) active.close();
            if (wake != null && wake.isHeld()) wake.release();
            if (stopping && store != null) try { store.activity("stopped"); } catch (Exception ignored) { /* Preserve private failures. */ }
            synchronized (this) {
                if (initialized && !stopping && !commands.isEmpty()) worker.submit(this::run);
                else { commands.clear(); started = false; stopSelfResult(latestStartId); }
            }
        }
    }
    private void retrieve(JSONObject config, MossClient client) throws Exception {
        report("retrieving");
        if (active == null) active = new RingConnection(this, config);
        try {
            Map<String, Integer> inventory = active.inventory();
            long inventoryAt = System.currentTimeMillis();
            store.recordings.inventory(inventory, inventoryAt);
            voice.inventory(inventory, client);
            for (String name : store.retrievalOrder(inventory.keySet())) {
                consumeCommands(client, config);
                Integer packetSize = inventory.get(name);
                String id = name.substring(0, name.length() - 5), sidecarName = id + ".json";
                Integer sidecarSize = inventory.get(sidecarName);
                boolean settled = packetSize.equals(previousInventory.get(name)) && sidecarSize != null && sidecarSize.equals(previousInventory.get(sidecarName));
                if (!RetrievalGate.wanted(id, store.contains(id), voice.intent(id) != null)) continue;
                if (!store.retrievalDue(id) || !RetrievalGate.ready(voice.intent(id) != null, sidecarSize, packetSize,
                    previousInventory.get(sidecarName), previousInventory.get(name))) continue;
                if (!store.hasStorageCapacity() || stopping) break;
                if (!store.contains(id) && !store.canDiscover()) continue;
                store.discover(id, voice.intent(id));
                if (packetSize > RingProtocol.PACKET_LIMIT || sidecarSize > RingProtocol.SIDECAR_LIMIT) {
                    store.failure(id, "source_size_limit", true); continue;
                }
                byte[] sidecar;
                try { sidecar = active.retrieve(sidecarName, sidecarSize); }
                catch (IllegalArgumentException invalid) { store.failure(id, "ring_file_invalid", false); throw invalid; }
                if (!store.admitSidecar(id, sidecar, settled)) { if (voice.intent(id) != null && admitRetries++ < 3) fastRetries = Math.max(fastRetries, 3); continue; }
                consumeCommands(client, config);
                if (store.excluded(id)) continue;
                store.reserveRetrieval(id, packetSize, sidecarSize, sidecar);
                try { active.retrieve(name, packetSize, store.file(id, "packets.bin")); }
                catch (IllegalArgumentException invalid) { store.failure(id, "ring_file_invalid", false); throw invalid; }
                store.retrieved(id, sidecar);
                if (voice.intent(id) != null) { fastRetries = 0; admitRetries = 0; }
            }
            previousInventory.clear(); previousInventory.putAll(inventory);
            if (!stopping) {
                active.readTelemetry();
                try {
                    long age = System.currentTimeMillis() - active.telemetry.recordingAt;
                    boolean recent = active.telemetry.recordingAt > 0 && age >= 0 && age < 60000;
                    boolean allowed = new DeliveryPreferences(this).recordingReminder() && getSystemService(NotificationManager.class).areNotificationsEnabled();
                    if (reminder.observe(allowed && recent, active.telemetry.recording,
                        active.telemetry.recordingSource, SystemClock.elapsedRealtime())) remindRecording();
                    else if (!reminder.tracking()) getSystemService(NotificationManager.class).cancel(3551);
                } catch (Exception unavailable) { /* A phone reminder cannot fail recording delivery. */ }
                int recordings = 0;
                for (String name : inventory.keySet()) if (name.endsWith(".opus")) recordings++;
                try { HardwareStatus.publish(this, config, active.telemetry, inventoryAt, recordings); }
                catch (Exception unavailable) { /* Optional status storage never blocks completed audio delivery. */ }
            }
        } catch (Exception error) { active.close(); active = null; throw error; }
        report(store.canDiscover() ? "waiting_for_completed_recordings" : "storage_capacity");
    }
    private void remindRecording() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) return;
        long window = reminder.window();
        Intent seen = new Intent(this, HardwareActivity.class).putExtra(ReminderDismissal.WINDOW, window);
        Intent dismissed = new Intent(this, ReminderDismissal.class).putExtra(ReminderDismissal.WINDOW, window);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        manager.notify(3551, new Notification.Builder(this, "recording-reminder-alert")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("Still recording on your ring?")
            .setContentText("Your ring has been recording for over an hour. Double-click its button to finish if you’re done.")
            .setStyle(new Notification.BigTextStyle().bigText("Your ring has been recording for over an hour. Double-click its button to finish if you’re done. Moss never stops a recording for you."))
            .setCategory(Notification.CATEGORY_REMINDER)
            .setContentIntent(PendingIntent.getActivity(this, 3, seen, flags))
            .setDeleteIntent(PendingIntent.getBroadcast(this, 4, dismissed, flags))
            .setAutoCancel(true).build());
    }
    private void deliver(MossClient client) throws Exception {
        for (String id : store.ids()) {
            if (stopping || Thread.currentThread().isInterrupted()) return;
            JSONObject entry = store.entries.getJSONObject(id);
            String stage = entry.getString("stage");
            if (store.boundary != null) store.boundary.run();
            if (!store.deliveryDue(id)) continue;
            report("delivering");
            try {
                if (stage.equals("retrieved")) { store.freeze(id); stage = "ready"; }
                store.checkDelivery(id);
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
            } catch (DeliveryStore.Excluded excluded) {
                if (entry.optBoolean("inFlight")) store.abandonAttempt(id);
            } catch (OwnerMismatch error) {
                if (entry.optBoolean("inFlight")) store.abandonAttempt(id);
                throw error;
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
    private void inspect(JSONObject config) throws Exception {
        if (getPackageManager().checkPermission(Manifest.permission.BLUETOOTH_CONNECT, OFFICIAL) == PackageManager.PERMISSION_GRANTED)
            throw new IllegalStateException("handoff_required");
        boolean owned = active == null;
        if (owned) active = new RingConnection(this, config);
        try {
            Map<String, Integer> inventory = active.inventory();
            long at = System.currentTimeMillis();
            store.recordings.inventory(inventory, at);
            active.readTelemetry();
            int count = 0;
            for (String name : inventory.keySet()) if (name.endsWith(".opus")) count++;
            HardwareStatus.publish(this, config, active.telemetry, at, count);
        } finally { if (owned) { active.close(); active = null; } }
    }
    private void consumeCommands(MossClient client, JSONObject config) throws Exception {
        Intent command;
        boolean ownerVerified = false;
        while ((command = commands.poll()) != null) {
            String action = command.getAction();
            // Local maintenance is available offline. Existing delivery commands still
            // require the credential's live owner before touching the queue or server.
            if (!recordingCommand(action) && !ownerVerified) {
                if (!client.owner().equals(config.getString("ownerId"))) throw new OwnerMismatch();
                ownerVerified = true;
            }
            if (action.equals("exclude-recording")) store.recordings.exclude(command.getStringExtra("scope"), command.getStringExtra("recordingId"),
                command.getStringExtra("selection"), command.getStringExtra("requestId"));
            else if (action.equals("inspect-ring")) {
                String result = "refreshed";
                try { inspect(config); }
                catch (InterruptedException interrupted) { throw interrupted; }
                catch (Exception unavailable) { result = "handoff_required".equals(unavailable.getMessage()) ? "handoff_required" : "ring_unavailable"; }
                store.recordings.receipt(command.getStringExtra("requestId"), result);
            }
            else if (action.equals("voice-on") || action.equals("voice-off")) voice.desired(action.equals("voice-on"));
            else if (action.equals("clear-completed")) store.clearCompleted();
            else if (action.equals("retry-transcription")) retryTranscription(store, command.getStringExtra("recordingId"), client::retryVoice);
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
