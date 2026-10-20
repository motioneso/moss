package ai.moss.vocci;

import java.nio.charset.StandardCharsets;
import org.json.*;

/** A completed sidecar is required before downloading its audio. */
final class CompletedSidecar {
    static final class TooLong extends Exception {}
    static boolean isComplete(byte[] sidecar) throws Exception {
        JSONArray rows = new JSONArray("[" + new String(sidecar, StandardCharsets.UTF_8) + "]");
        boolean end = false;
        double duration = -1;
        for (int n = 0; n < rows.length(); n++) {
            JSONObject row = rows.getJSONObject(n);
            JSONArray record = row.optJSONArray("record"), time = row.optJSONArray("duration");
            if (record != null && record.length() >= 2 && "end".equals(record.optString(1))) end = true;
            if (time != null && time.length() >= 2) duration = Math.max(duration, time.optDouble(1, -1));
        }
        if (!end) return false;
        if (!(duration > 0) || !Double.isFinite(duration)) throw new JSONException("invalid duration");
        if (duration > 120000) throw new TooLong();
        return true;
    }
}
