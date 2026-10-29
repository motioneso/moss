package ai.moss.android;

import android.content.Context;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Service-worker-owned observations and exclusions. Never removes source or phone evidence. */
final class RingRecordings {
    private static final String[] IDENTITY = {"origin", "ownerId", "deviceId", "sn", "address"};
    private final File file;
    final JSONObject state;
    RingRecordings(Context context, JSONObject config, String sourceDeviceId) throws Exception {
        file = file(context);
        String scope = scope(config, sourceDeviceId);
        state = file.exists() || new File(file.getPath() + ".bak").exists() ? PrivateFiles.json(file) : new JSONObject().put("scope", scope)
            .put("sources", new JSONObject()).put("exclusions", new JSONObject());
        if (!scope.equals(state.getString("scope"))) throw new IllegalStateException("recording_identity_change");
        state.getJSONObject("sources"); state.getJSONObject("exclusions");
    }
    private static File file(Context context) { return new File(context.getNoBackupFilesDir(), "ring-recordings.json"); }
    private static String scope(JSONObject config, String sourceDeviceId) throws Exception {
        JSONArray fields = new JSONArray().put(sourceDeviceId);
        for (String field : IDENTITY) fields.put(config.getString(field));
        return RingAuth.hex(MessageDigest.getInstance("SHA-256").digest(fields.toString().getBytes(StandardCharsets.UTF_8)));
    }
    static JSONObject read(Context context, JSONObject config, String sourceDeviceId) {
        try {
            JSONObject saved = PrivateFiles.json(file(context));
            return scope(config, sourceDeviceId).equals(saved.getString("scope")) ? saved : new JSONObject();
        } catch (Exception unavailable) { return new JSONObject(); }
    }
    void inventory(Map<String, Integer> inventory, long at) throws Exception {
        if (inventory.size() > 1024) throw new IllegalArgumentException("inventory_limit");
        JSONObject sources = new JSONObject();
        for (String name : new TreeSet<>(inventory.keySet())) {
            if (!name.endsWith(".opus") || !RingProtocol.validName(name)) continue;
            String id = name.substring(0, name.length() - 5);
            sources.put(id, new JSONObject().put("audioBytes", inventory.get(name))
                .put("sidecarBytes", inventory.containsKey(id + ".json") ? inventory.get(id + ".json") : JSONObject.NULL));
        }
        state.put("sources", sources).put("inventoryAt", at);
        save();
    }
    boolean excluded(String id) { return state.optJSONObject("exclusions").has(id); }
    static String selection(JSONObject state, String id) {
        JSONObject source = state.optJSONObject("sources");
        JSONObject item = source == null ? null : source.optJSONObject(id);
        return item == null ? "" : id + ":" + item.optInt("audioBytes") + ":" + item.optString("sidecarBytes");
    }
    String exclude(String expectedScope, String id, String selected, String request) throws Exception {
        String result;
        JSONObject exclusions = state.getJSONObject("exclusions");
        if (!state.getString("scope").equals(expectedScope)) result = "recording_identity_change";
        else if (id == null || !RingProtocol.validName(id + ".opus") || selected == null || selected.isEmpty() || !selected.equals(selection(state, id))) result = "source_changed";
        else if (!excluded(id) && exclusions.length() >= 1024) result = "exclusion_limit";
        else {
            if (!excluded(id)) exclusions.put(id, System.currentTimeMillis());
            result = "excluded";
        }
        receipt(request, result); return result;
    }
    void receipt(String request, String result) throws Exception {
        state.put("command", new JSONObject().put("id", request).put("result", result).put("at", System.currentTimeMillis())); save();
    }
    private void save() throws Exception { PrivateFiles.json(file, state); }
}
