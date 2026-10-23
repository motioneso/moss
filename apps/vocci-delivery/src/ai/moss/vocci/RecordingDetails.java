package ai.moss.vocci;

import java.io.File;
import org.json.JSONObject;

/** Inspection uses retained evidence only; inventory size is not proof of completion. */
final class RecordingDetails {
    static String metadata(File deliveryRoot, String id) {
        if (!RingProtocol.validName(id + ".opus")) return "Completion and duration unknown";
        File sidecar = new File(new File(deliveryRoot, id), "sidecar.bin");
        if (!sidecar.exists()) return "Completion and duration unknown · no retained metadata";
        try {
            long duration = CompletedSidecar.duration(PrivateFiles.read(sidecar, RingProtocol.SIDECAR_LIMIT), Long.MAX_VALUE);
            return duration == 0 ? "Retained metadata has no completion marker" : "Completed in retained metadata · " + duration / 1000.0 + " seconds";
        } catch (Exception unavailable) { return "Retained metadata unavailable or invalid · completion unknown"; }
    }
    static String delivery(JSONObject entry) {
        if (entry == null) return "No phone delivery entry · completion unknown";
        String stage = entry.optString("stage", "unknown");
        return "Phone delivery: " + stage.replace('-', ' ') + (entry.has("error") ? " · " + entry.optString("error").replace('_', ' ') : "") +
            (entry.optBoolean("cleared") ? "\nCompleted phone audio cleared" : "\nPhone evidence is kept when available") +
            (entry.has("status") ? "\nMoss last reported: " + entry.optJSONObject("status").optString("state", "unknown") : "\nMoss acceptance not confirmed");
    }
}
