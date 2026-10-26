package ai.moss.android;

import java.util.*;
import org.json.*;

/** Worker-owned opt-in journal. Persist intent before network I/O, including lost-response recovery. */
final class VoiceDelivery {
    interface Port {
        JSONObject enable(JSONObject snapshot) throws Exception;
        JSONObject disable(String id) throws Exception;
    }
    private final DeliveryStore store;
    final JSONObject state;
    private boolean hasInventory;
    private Map<String, Integer> previous = new HashMap<>();
    VoiceDelivery(DeliveryStore store) throws Exception {
        this.store = store;
        if (!store.state.has("voice")) store.state.put("voice", new JSONObject().put("desired", false).put("baseline", new JSONObject()));
        state = store.state.getJSONObject("voice");
    }
    void desired(boolean enabled) throws Exception {
        state.put("desired", enabled);
        if (!enabled && state.has("enablement")) state.put("disableId", state.getJSONObject("enablement").getString("id"));
        hasInventory = false; store.save();
    }
    void synchronize(Port port) throws Exception {
        JSONObject snapshot = state.optJSONObject("snapshot");
        if (snapshot != null) {
            JSONObject result = port.enable(new JSONObject(snapshot.toString()));
            validate(result);
            if (!state.optBoolean("desired") || !result.getBoolean("enabled")) state.put("disableId", result.getString("id"));
            state.put("enablement", result); state.remove("snapshot"); store.save();
        }
        if (state.has("disableId")) {
            String id = state.getString("disableId");
            JSONObject result = port.disable(id); validate(result);
            if (!id.equals(result.getString("id")) || result.getBoolean("enabled")) throw new IllegalStateException("enablement_identity");
            state.remove("disableId"); state.remove("enablement"); store.save();
        }
    }
    void inventory(Map<String, Integer> inventory, Port port) throws Exception {
        boolean stable = hasInventory && previous.equals(inventory);
        previous = new HashMap<>(inventory); hasInventory = true;
        synchronize(port);
        if (!state.optBoolean("desired") || state.has("enablement") || !stable) return;
        SortedSet<String> ids = new TreeSet<>(store.ids());
        for (String name : inventory.keySet()) {
            if (name.endsWith(".opus") || name.endsWith(".json")) ids.add(name.substring(0, name.length() - 5));
        }
        if (ids.size() > 1024) throw new IllegalStateException("inventory_limit");
        JSONObject baseline = state.getJSONObject("baseline");
        for (String id : ids) baseline.put(id, true);
        state.put("snapshot", new JSONObject().put("version", 2).put("sourceDeviceId", store.state.getString("sourceDeviceId"))
            .put("requestKey", UUID.randomUUID().toString()).put("recordingIds", new JSONArray(ids)));
        store.save(); // Freeze the exact inventory and key before POST; never rebuild after a lost response.
        synchronize(port);
    }
    /** True while hold-to-talk is on and the receiver has confirmed it. */
    boolean active() {
        JSONObject epoch = state.optJSONObject("enablement");
        return state.optBoolean("desired") && epoch != null && epoch.optBoolean("enabled");
    }
    JSONObject intent(String id) throws Exception {
        JSONObject epoch = state.optJSONObject("enablement");
        if (!id.startsWith("amsg_") || !state.optBoolean("desired") || epoch == null || !epoch.getBoolean("enabled") ||
            state.has("snapshot") || state.has("disableId") || state.getJSONObject("baseline").has(id)) return null;
        // Inventory discovery is not a capture observation. Moss must require explicit Send.
        return new JSONObject().put("enablementId", epoch.getString("id")).put("capturedAt", JSONObject.NULL);
    }
    private void validate(JSONObject result) throws Exception {
        MossClient.uuid(result.getString("id"));
        if (!store.state.getString("sourceDeviceId").equals(result.getString("sourceDeviceId"))) throw new IllegalStateException("enablement_identity");
        result.getBoolean("enabled"); result.getString("enabledAt");
    }
}
