package ai.moss.vocci;

import android.content.Context;
import android.util.Base64;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONObject;

/** One service worker owns all writes. Atomic files are recovery boundaries. */
final class DeliveryStore {
    static final class Conflict extends Exception {
        Conflict(String code) { super(code); }
    }
    private final File root, stateFile;
    final JSONObject state, entries;
    DeliveryStore(Context context) throws Exception {
        root = new File(context.getNoBackupFilesDir(), "delivery"); stateFile = new File(root, "state.json");
        state = stateFile.exists() ? PrivateFiles.json(stateFile) : new JSONObject().put("sourceDeviceId", UUID.randomUUID().toString()).put("entries", new JSONObject());
        entries = state.getJSONObject("entries");
        for (String id : ids()) {
            JSONObject entry = entries.getJSONObject(id);
            if (entry.optBoolean("inFlight") && entry.optInt("attempts") >= RetryPolicy.MAX_ATTEMPTS)
                entry.put("stage", "failed").put("error", "retry_exhausted");
        }
        save();
    }
    void save() throws Exception { PrivateFiles.json(stateFile, state); }
    void activity(String code) throws Exception {
        state.put("activity", code).put("outcome", blocked(code) ? "blocked" : code.equals("stopped") ? "stopped" : "active")
            .put("updatedAt", System.currentTimeMillis()); save();
    }
    private static boolean blocked(String code) {
        return Arrays.asList("handoff_required", "owner_mismatch", "session_refresh_required", "configuration_or_storage_required", "storage_capacity", "server_rejected").contains(code);
    }
    List<String> ids() { List<String> ids = new ArrayList<>(); entries.keys().forEachRemaining(ids::add); return ids; }
    boolean contains(String id) { return entries.has(id); }
    List<String> retrievalOrder(Collection<String> names) {
        List<String> order = new ArrayList<>();
        for (String name : names) if (name.endsWith(".opus")) order.add(name);
        // Try healthy/new sources before a source that already broke a session.
        order.sort(Comparator.comparingInt(name -> {
            JSONObject entry = entries.optJSONObject(name.substring(0, name.length() - 5));
            return entry == null ? 0 : entry.optInt("attempts");
        }));
        return order;
    }
    boolean hasStorageCapacity() { return root.getUsableSpace() > 150 * 1024 * 1024L && size(root) < 100 * 1024 * 1024L; }
    boolean canDiscover() {
        int retained = 0;
        for (String id : ids()) if (!entries.optJSONObject(id).optBoolean("cleared")) retained++;
        return retained < 100 && entries.length() < 1024 && hasStorageCapacity();
    }
    boolean needsRetrieval(String id) throws Exception { return !contains(id) || entries.getJSONObject(id).getString("stage").equals("discovered"); }
    boolean retrievalDue(String id) throws Exception {
        if (!contains(id)) return true;
        JSONObject entry = entries.getJSONObject(id);
        return needsRetrieval(id) && RetryPolicy.due(entry.optInt("attempts"), entry.optLong("nextAt"), System.currentTimeMillis());
    }
    void discover(String id) throws Exception { discover(id, null); }
    void discover(String id, JSONObject voiceIntent) throws Exception {
        if (contains(id)) return;
        if (!canDiscover()) throw new IllegalStateException("storage_capacity");
        JSONObject entry = new JSONObject().put("stage", "discovered").put("attempts", 0).put("nextAt", 0);
        if (voiceIntent != null) entry.put("voiceIntent", voiceIntent);
        entries.put(id, entry); save();
    }
    boolean admitSidecar(String id, byte[] sidecar) throws Exception {
        try { return CompletedSidecar.isComplete(sidecar); }
        catch (CompletedSidecar.TooLong invalid) { rejectSidecar(id, sidecar, "duration_limit"); return false; }
        catch (org.json.JSONException invalid) { rejectSidecar(id, sidecar, "sidecar_invalid"); return false; }
    }
    private void rejectSidecar(String id, byte[] sidecar, String code) throws Exception {
        PrivateFiles.write(file(id, "sidecar.bin"), sidecar);
        failure(id, code, true);
    }
    private long size(File file) {
        if (!file.isDirectory()) return file.length();
        long sum = 0; File[] files = file.listFiles();
        if (files != null) for (File child : files) sum += size(child);
        return sum;
    }
    File file(String id, String name) {
        if (!RingProtocol.validName(id + ".opus")) throw new IllegalArgumentException("identity");
        return new File(new File(root, id), name);
    }
    void retrieved(String id, byte[] packets, byte[] sidecar) throws Exception {
        if (!needsRetrieval(id)) return;
        discover(id);
        if (!hasStorageCapacity()) throw new IllegalStateException("storage_capacity");
        PrivateFiles.write(file(id, "packets.bin"), packets);
        retrieved(id, sidecar);
    }
    void retrieved(String id, byte[] sidecar) throws Exception {
        if (!needsRetrieval(id)) return;
        File packets = file(id, "packets.bin");
        if (packets.length() < 1 || packets.length() > RingProtocol.PACKET_LIMIT) throw new IllegalArgumentException("packet_size");
        PrivateFiles.write(file(id, "sidecar.bin"), sidecar);
        entries.getJSONObject(id).put("stage", "retrieved").put("attempts", 0).put("nextAt", 0); save();
    }
    static JSONObject manifest(String name, byte[] bytes) throws Exception {
        return new JSONObject().put("name", name).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            .put("sha256", RingAuth.hex(MessageDigest.getInstance("SHA-256").digest(bytes)));
    }
    void freeze(String id) throws Exception {
        File bundle = file(id, "bundle.json");
        if (!bundle.exists()) {
            File audio = file(id, "audio.wav");
            OpusWav.decode(file(id, "packets.bin"), audio);
            byte[] packets = PrivateFiles.read(file(id, "packets.bin"), RingProtocol.PACKET_LIMIT);
            byte[] sidecar = PrivateFiles.read(file(id, "sidecar.bin"), RingProtocol.SIDECAR_LIMIT);
            byte[] wav = PrivateFiles.read(audio, 3_840_044);
            JSONObject input = new JSONObject().put("version", 1).put("sourceDeviceId", state.getString("sourceDeviceId")).put("recordingId", id)
                .put("packets", manifest(id + ".opus", packets)).put("sidecar", manifest(id + ".json", sidecar)).put("wav", manifest(id + ".wav", wav));
            JSONObject intent = entries.getJSONObject(id).optJSONObject("voiceIntent");
            if (intent != null) input = new JSONObject().put("version", 2).put("intent", "voice-request")
                .put("enablementId", intent.getString("enablementId")).put("capturedAt", intent.get("capturedAt")).put("recording", input);
            PrivateFiles.json(bundle, input);
        }
        entries.getJSONObject(id).put("stage", "ready"); save();
    }
    void beginAttempt(String id) throws Exception {
        JSONObject entry = entries.getJSONObject(id);
        int attempts = entry.optInt("attempts") + 1;
        entry.put("inFlight", true).put("attempts", attempts)
            .put("nextAt", System.currentTimeMillis() + RetryPolicy.delayMs(attempts));
        save();
    }
    void abandonAttempt(String id) throws Exception {
        JSONObject entry = entries.getJSONObject(id);
        entry.remove("inFlight"); entry.put("attempts", Math.max(0, entry.optInt("attempts") - 1)); save();
    }
    void accepted(String id, JSONObject status) throws Exception {
        JSONObject entry = entries.getJSONObject(id);
        boolean voice = entry.has("voiceIntent");
        if (entry.has("status")) {
            JSONObject previous = entry.getJSONObject("status");
            if (!previous.getString("id").equals(status.getString("id")) ||
                (!voice && !previous.getString("meetingId").equals(status.getString("meetingId"))) ||
                (voice && !previous.isNull("voiceRequestId") && !previous.getString("voiceRequestId").equals(status.optString("voiceRequestId"))))
                throw new Conflict("server_identity_change");
        }
        if (voice ? !status.getString("intent").equals("voice-request") :
            !status.getString("mode").equals(id.startsWith("amsg_") ? "voice-request" : "normal")) throw new Conflict("server_mode_change");
        String stage = status.getString("state");
        if (voice && stage.equals("complete")) {
            if (status.isNull("voiceRequestId")) throw new Conflict("server_identity_change");
            stage = "voice-status";
        } else if (!stage.equals("complete") && !stage.equals("failed")) stage = "accepted";
        entry.remove("inFlight"); entry.remove("error");
        entry.put("status", status).put("stage", stage).put("attempts", 0).put("nextAt", System.currentTimeMillis() + 30000); save();
    }
    void chatStatus(String id, JSONObject value) throws Exception {
        JSONObject entry = entries.getJSONObject(id), previous = entry.optJSONObject("chatStatus");
        if (!entry.getJSONObject("status").getString("voiceRequestId").equals(value.getString("id")) ||
            !state.getString("sourceDeviceId").equals(value.getString("sourceDeviceId")) || !id.equals(value.getString("recordingId")) ||
            (previous != null && !previous.getString("threadId").equals(value.getString("threadId")))) throw new Conflict("server_identity_change");
        if (previous != null) for (String key : new String[]{"userMessageId", "assistantMessageId"}) {
            if (!previous.isNull(key) && !previous.getString(key).equals(value.optString(key))) throw new Conflict("server_identity_change");
        }
        String status = value.getString("state");
        entry.put("chatStatus", value).put("stage", Arrays.asList("replied", "no-speech", "interrupted").contains(status) ? status : "voice-status")
            .put("attempts", 0).put("nextAt", System.currentTimeMillis() + 30000);
        entry.remove("inFlight"); entry.remove("error"); save();
    }
    static boolean completed(String stage) { return Arrays.asList("complete", "replied", "no-speech").contains(stage); }
    void clearCompleted() throws Exception {
        for (String id : ids()) {
            JSONObject entry = entries.getJSONObject(id);
            if (!completed(entry.getString("stage"))) continue;
            for (String name : new String[]{"packets.bin", "sidecar.bin", "audio.wav", "bundle.json"}) {
                File file = file(id, name);
                if (file.exists() && !file.delete()) throw new java.io.IOException("storage_cleanup");
            }
            file(id, "bundle.json").getParentFile().delete();
            // Retain the identity tombstone so the ring cannot redownload cleared evidence.
            entry.put("cleared", true);
        }
        save();
    }
    void httpFailure(String id, int status, boolean terminal) throws Exception {
        entries.getJSONObject(id).put("httpStatus", status);
        failure(id, terminal ? "server_rejected" : "transfer_retry", terminal);
    }
    void failure(String id, String code, boolean terminal) throws Exception {
        JSONObject entry = entries.getJSONObject(id);
        int attempts = entry.optInt("attempts") + (entry.optBoolean("inFlight") ? 0 : 1);
        entry.remove("inFlight");
        entry.put("attempts", attempts).put("error", code);
        if (terminal || attempts >= RetryPolicy.MAX_ATTEMPTS) entry.put("stage", "failed");
        else entry.put("nextAt", System.currentTimeMillis() + RetryPolicy.delayMs(attempts));
        save();
    }
}
