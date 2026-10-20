package ai.moss.vocci;

import java.nio.charset.StandardCharsets;
import org.json.*;

/** A completed sidecar is required before downloading its audio. */
final class CompletedSidecar {
    static boolean isComplete(byte[] sidecar) throws Exception {
        JSONArray rows = new JSONArray("[" + new String(sidecar, StandardCharsets.UTF_8) + "]");
        boolean end = false, duration = false;
        for (int n = 0; n < rows.length(); n++) {
            JSONObject row = rows.getJSONObject(n);
            JSONArray record = row.optJSONArray("record"), time = row.optJSONArray("duration");
            if (record != null && record.length() >= 2 && "end".equals(record.optString(1))) end = true;
            if (time != null && time.length() >= 2 && time.optDouble(1, -1) > 0 && time.optDouble(1, -1) <= 120000) duration = true;
        }
        return end && duration;
    }
}
