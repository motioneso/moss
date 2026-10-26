package ai.moss.android;

import android.content.Context;
import java.io.File;
import org.json.JSONObject;

/** Serialized delivery or explicitly stopped-delivery diagnostics publish this atomic snapshot. */
final class HardwareStatus {
    static JSONObject read(Context context, JSONObject config) {
        try {
            JSONObject snapshot = PrivateFiles.json(file(context));
            return snapshot.optString("ringId").equals(config.getString("deviceId")) &&
                snapshot.optString("ownerId").equals(config.getString("ownerId")) && snapshot.optString("origin").equals(config.getString("origin")) &&
                snapshot.optString("sn").equals(config.getString("sn")) ? snapshot : new JSONObject();
        } catch (Exception unavailable) { return new JSONObject(); }
    }
    static void publish(Context context, JSONObject config, RingTelemetry telemetry, long inventoryAt, int recordings) throws Exception {
        JSONObject snapshot = read(context, config);
        snapshot.put("ringId", config.getString("deviceId")).put("sn", config.getString("sn"))
            .put("ownerId", config.getString("ownerId")).put("origin", config.getString("origin"))
            .put("contactAt", Math.max(inventoryAt, Math.max(telemetry.recordingAt, Math.max(telemetry.storageAt, telemetry.infoAt))))
            .put("inventoryAt", inventoryAt).put("recordings", recordings);
        if (telemetry.info != null) snapshot.put("info", new JSONObject().put("at", telemetry.infoAt)
            .put("hardware", telemetry.info.hardware).put("firmware", telemetry.info.firmware)
            .put("model", telemetry.info.model).put("battery", telemetry.info.battery));
        if (telemetry.storage != null) snapshot.put("storage", new JSONObject().put("at", telemetry.storageAt)
            .put("free", telemetry.storage.free).put("used", telemetry.storage.used).put("total", telemetry.storage.total));
        if (telemetry.recording != null) snapshot.put("recording", new JSONObject().put("at", telemetry.recordingAt).put("state", telemetry.recording));
        PrivateFiles.json(file(context), snapshot);
    }
    private static File file(Context context) { return new File(context.getNoBackupFilesDir(), "hardware.json"); }
    static String recordingLabel(String state) {
        switch (state) {
            case "idle": return "Idle";
            case "recording": return "Recording";
            case "hold": return "Hold-to-talk recording";
            case "not_bound": return "Ring reports no binding";
            case "low_battery": return "Recording blocked: low battery";
            case "low_storage": return "Recording blocked: storage full";
            case "hardware_error": return "Ring reports a hardware error";
            default: return "Recording state unavailable";
        }
    }
}
