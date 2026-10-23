package ai.moss.vocci;

import android.content.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Installed assertions exercise Android AtomicFile/JSON; all fixtures use an isolated journal. */
final class RecordingChecks {
    private static void check(boolean value) { DeviceChecks.check(value); }
    private static JSONObject config() throws Exception {
        return new JSONObject().put("origin", "https://example.test").put("ownerId", "owner")
            .put("deviceId", "ring").put("sn", "serial").put("address", "AA:BB:CC:DD:EE:FF");
    }
    private static Map<String, Integer> inventory(String id) {
        Map<String, Integer> files = new LinkedHashMap<>(); files.put(id + ".opus", 10); files.put(id + ".json", 40); return files;
    }
    private static void exclude(RingRecordings recordings, String id) throws Exception {
        check(recordings.exclude(recordings.state.getString("scope"), id, RingRecordings.selection(recordings.state, id), UUID.randomUUID().toString()).equals("excluded"));
    }
    private static final class Server implements ResumableUpload.Port {
        int reserves, chunks, finalizations, polls;
        final String id = "55555555-5555-4555-8555-555555555555";
        JSONObject progress() throws Exception {
            return new JSONObject().put("id", id).put("fingerprint", "b".repeat(64)).put("chunkBytes", ResumableUpload.CHUNK_BYTES)
                .put("expiresAt", "2026-12-01T00:00:00Z").put("reserved", true).put("ready", false).put("expired", false)
                .put("received", new JSONObject().put("packets", new JSONArray()).put("sidecar", new JSONArray()).put("wav", new JSONArray()));
        }
        @Override public JSONObject reserveUpload(byte[] bytes) throws Exception { reserves++; return progress(); }
        @Override public JSONObject uploadProgress(String id) throws Exception { return progress(); }
        @Override public JSONObject putChunk(String id, String kind, int index, byte[] bytes) throws Exception { chunks++; return progress(); }
        @Override public JSONObject finalizeUpload(String id) throws Exception { finalizations++; return progress(); }
        @Override public JSONObject poll(String id) throws Exception { polls++; return new JSONObject(); }
        @Override public JSONObject pollVoice(String id) throws Exception { return poll(id); }
    }
    static void run(Context parent, byte[] packets) throws Exception {
        Context context = new ContextWrapper(parent) {
            @Override public File getNoBackupFilesDir() { return new File(parent.getNoBackupFilesDir(), "recording-checks"); }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return parent.getSharedPreferences("recording-checks-" + name, mode); }
        };
        DeliveryStore store = new DeliveryStore(context);
        String source = store.state.getString("sourceDeviceId"), id = "1700000400_exclude";
        RingRecordings recordings = new RingRecordings(context, config(), source); store.recordings = recordings;
        check(!recordings.state.has("inventoryAt"));
        Map<String, Integer> files = inventory(id); files.put("1700000401_orphan.opus", 12);
        recordings.inventory(files, 1234);
        check(recordings.state.getJSONObject("sources").length() == 2);
        check(recordings.state.getJSONObject("sources").getJSONObject("1700000401_orphan").isNull("sidecarBytes"));
        String selected = RingRecordings.selection(recordings.state, id);
        check(recordings.exclude("other-scope", id, selected, "wrong-owner").equals("recording_identity_change"));
        check(!recordings.excluded(id));
        check(recordings.exclude(recordings.state.getString("scope"), "1700000499_unknown", selected, "unknown").equals("source_changed"));
        files.put(id + ".opus", 11); recordings.inventory(files, 1235);
        check(recordings.exclude(recordings.state.getString("scope"), id, selected, "stale").equals("source_changed"));
        check(!recordings.excluded(id));
        check(store.retrievalDue(id));
        exclude(recordings, id); // Before discovery: no journal entry or voice destination is created.
        check(!store.retrievalDue(id) && !store.needsRetrieval(id));
        try { store.discover(id); throw new AssertionError("excluded discovery"); } catch (DeliveryStore.Excluded expected) { }
        check(!store.contains(id));
        recordings = new RingRecordings(context, config(), source);
        recordings.inventory(Collections.emptyMap(), 1236);
        recordings.inventory(files, 1237);
        check(recordings.excluded(id));
        check(RingRecordings.read(context, config(), source).getJSONObject("exclusions").has(id));
        for (String field : new String[]{"origin", "ownerId", "deviceId", "sn", "address", "source"}) {
            JSONObject changed = config(); String changedSource = source;
            if (field.equals("source")) changedSource = "other-journal"; else changed.put(field, "different");
            check(RingRecordings.read(context, changed, changedSource).length() == 0);
            try { new RingRecordings(context, changed, changedSource); throw new AssertionError("identity adopted"); }
            catch (IllegalStateException expected) { check(expected.getMessage().equals("recording_identity_change")); }
        }
        // Admission/transfer boundary: an already discovered source also stops before audio admission.
        store = new DeliveryStore(context); store.recordings = recordings;
        String admitted = "1700000402_admitted";
        store.discover(admitted); recordings.inventory(inventory(admitted), 1238); exclude(recordings, admitted);
        check(!store.needsRetrieval(admitted));
        store.retrieved(admitted, packets, new byte[]{1});
        check(!store.file(admitted, "packets.bin").exists());
        check(store.entries.getJSONObject(admitted).getString("stage").equals("discovered"));
        // Exclusion after a chunk acknowledgement stops every later chunk/finalization/poll.
        String queued = "1700000403_queued";
        store.discover(queued); store.retrieved(queued, packets, "{}".getBytes(StandardCharsets.UTF_8)); store.freeze(queued);
        recordings.inventory(inventory(queued), 1239);
        Server server = new Server();
        RingRecordings ledger = recordings;
        store.boundary = () -> { if (server.chunks == 1 && !ledger.excluded(queued)) exclude(ledger, queued); };
        byte[] manifest = PrivateFiles.read(store.file(queued, "upload.json"), 4096);
        store.beginAttempt(queued);
        try { ResumableUpload.deliver(server, store, queued); throw new AssertionError("excluded upload continued"); }
        catch (DeliveryStore.Excluded expected) { store.abandonAttempt(queued); }
        check(server.reserves == 1 && server.chunks == 1 && server.finalizations == 0 && server.polls == 0);
        check(Arrays.equals(manifest, PrivateFiles.read(store.file(queued, "upload.json"), 4096)));
        check(store.entries.getJSONObject(queued).optInt("attempts") == 0);
        check(store.entries.getJSONObject(queued).has("uploadProgress"));
        store = new DeliveryStore(context); store.recordings = new RingRecordings(context, config(), source);
        check(!store.deliveryDue(queued));
        try { ResumableUpload.deliver(server, store, queued); throw new AssertionError("restart uploaded exclusion"); }
        catch (DeliveryStore.Excluded expected) { }
        check(server.reserves == 1 && server.chunks == 1);
        // Completed, failed and interrupted evidence is not removed or reassigned by exclusion.
        for (String stage : new String[]{"complete", "failed", "interrupted"}) {
            String retained = "1700000410_" + stage;
            store.discover(retained); store.retrieved(retained, packets, "{}".getBytes(StandardCharsets.UTF_8));
            store.entries.getJSONObject(retained).put("stage", stage).put("voiceIntent", new JSONObject().put("enablementId", "original")); store.save();
            String before = store.entries.getJSONObject(retained).toString();
            store.recordings.inventory(inventory(retained), 1240); exclude(store.recordings, retained);
            check(store.entries.getJSONObject(retained).toString().equals(before));
            check(store.file(retained, "packets.bin").exists() && !store.deliveryDue(retained));
        }
        File deliveryRoot = new File(context.getNoBackupFilesDir(), "delivery");
        check(RecordingDetails.metadata(deliveryRoot, id).contains("unknown"));
        check(RecordingDetails.metadata(deliveryRoot, queued).contains("no completion marker"));
        PrivateFiles.write(store.file(queued, "sidecar.bin"), "{\"record\":[1,\"end\"]},{\"duration\":[1,2000]}".getBytes(StandardCharsets.UTF_8));
        check(RecordingDetails.metadata(deliveryRoot, queued).contains("2.0 seconds"));
        PrivateFiles.write(store.file(queued, "sidecar.bin"), new byte[]{1});
        check(RecordingDetails.metadata(deliveryRoot, queued).contains("invalid"));
        Map<String, Integer> tooMany = new HashMap<>();
        for (int n = 0; n < 1025; n++) tooMany.put("1700000500_" + n + ".opus", 1);
        long previousAt = store.recordings.state.getLong("inventoryAt");
        try { store.recordings.inventory(tooMany, 9999); throw new AssertionError("unbounded inventory"); }
        catch (IllegalArgumentException expected) { check(previousAt == store.recordings.state.getLong("inventoryAt")); }
        DeliveryPreferences choices = new DeliveryPreferences(context);
        boolean previous = choices.enabled();
        try {
            choices.enabled(false);
            check(DeliveryService.recordingCommand("inspect-ring") && DeliveryService.recordingCommand("exclude-recording"));
            check(!choices.applyAction("inspect-ring") && !choices.applyAction("exclude-recording"));
            check(!choices.enabled());
        } finally { choices.enabled(previous); parent.deleteSharedPreferences("recording-checks-delivery-choices"); }
    }
}
