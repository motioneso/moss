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
    boolean canDiscover() { return entries.length() < 100 && hasStorageCapacity(); }
    boolean needsRetrieval(String id) throws Exception { return !contains(id) || entries.getJSONObject(id).getString("stage").equals("discovered"); }
    boolean retrievalDue(String id) throws Exception {
        if (!contains(id)) return true;
        JSONObject entry = entries.getJSONObject(id);
        return needsRetrieval(id) && RetryPolicy.due(entry.optInt("attempts"), entry.optLong("nextAt"), System.currentTimeMillis());
    }
    void discover(String id) throws Exception {
        if (contains(id)) return;
        if (!canDiscover()) throw new IllegalStateException("storage_capacity");
        entries.put(id, new JSONObject().put("stage", "discovered").put("attempts", 0).put("nextAt", 0)); save();
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
    void abandonAttempt(String id) throws Exception {
        JSONObject entry = entries.getJSONObject(id);
        entry.remove("inFlight"); entry.put("attempts", Math.max(0, entry.optInt("attempts") - 1)); save();
    }
    void accepted(String id, JSONObject status) throws Exception {
        JSONObject entry = entries.getJSONObject(id);
        if (entry.has("status") && (!entry.getJSONObject("status").getString("id").equals(status.getString("id")) ||
            !entry.getJSONObject("status").getString("meetingId").equals(status.getString("meetingId")))) throw new Conflict("server_identity_change");
        if (!status.getString("mode").equals(id.startsWith("amsg_") ? "voice-request" : "normal")) throw new Conflict("server_mode_change");
        String stage = status.getString("state");
        entry.remove("inFlight");
        entry.put("status", status).put("stage", stage.equals("complete") || stage.equals("failed") ? stage : "accepted")
            .put("attempts", 0).put("nextAt", System.currentTimeMillis() + 30000); save();
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
