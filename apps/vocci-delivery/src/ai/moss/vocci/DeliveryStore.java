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
    void activity(String code) throws Exception { state.put("activity", code); state.put("updatedAt", System.currentTimeMillis()); save(); }
    List<String> ids() { List<String> ids = new ArrayList<>(); entries.keys().forEachRemaining(ids::add); return ids; }
    boolean contains(String id) { return entries.has(id); }
    boolean capacity() { return entries.length() < 100 && root.getUsableSpace() > 150 * 1024 * 1024L && size(root) < 100 * 1024 * 1024L; }
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
        if (contains(id)) return;
        if (!capacity()) throw new IllegalStateException("storage_capacity");
        PrivateFiles.write(file(id, "packets.bin"), packets);
        PrivateFiles.write(file(id, "sidecar.bin"), sidecar);
        entries.put(id, new JSONObject().put("stage", "retrieved").put("attempts", 0).put("nextAt", 0)); save();
    }
    static JSONObject manifest(String name, byte[] bytes) throws Exception {
        return new JSONObject().put("name", name).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            .put("sha256", RingAuth.hex(MessageDigest.getInstance("SHA-256").digest(bytes)));
    }
    void freeze(String id) throws Exception {
        File bundle = file(id, "bundle.json");
        if (!bundle.exists()) {
            byte[] packets = PrivateFiles.read(file(id, "packets.bin"), RingProtocol.PACKET_LIMIT);
            byte[] sidecar = PrivateFiles.read(file(id, "sidecar.bin"), RingProtocol.SIDECAR_LIMIT);
            byte[] wav = OpusWav.decode(packets);
            JSONObject input = new JSONObject().put("version", 1).put("sourceDeviceId", state.getString("sourceDeviceId")).put("recordingId", id)
                .put("packets", manifest(id + ".opus", packets)).put("sidecar", manifest(id + ".json", sidecar)).put("wav", manifest(id + ".wav", wav));
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
    void accepted(String id, JSONObject status) throws Exception {
        JSONObject entry = entries.getJSONObject(id);
        if (entry.has("status") && (!entry.getJSONObject("status").getString("id").equals(status.getString("id")) ||
            !entry.getJSONObject("status").getString("meetingId").equals(status.getString("meetingId")))) throw new IllegalStateException("server_identity_change");
        if (!status.getString("mode").equals(id.startsWith("amsg_") ? "voice-request" : "normal")) throw new IllegalStateException("server_mode_change");
        String stage = status.getString("state");
        entry.remove("inFlight");
        entry.put("status", status).put("stage", stage.equals("complete") || stage.equals("failed") ? stage : "accepted")
            .put("attempts", 0).put("nextAt", System.currentTimeMillis() + 30000); save();
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
