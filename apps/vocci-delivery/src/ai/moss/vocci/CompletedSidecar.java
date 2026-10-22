package ai.moss.vocci;

import java.nio.charset.StandardCharsets;
import org.json.*;

/** A completed sidecar is required before downloading its audio. */
final class CompletedSidecar {
    static final class TooLong extends Exception {}
    static boolean isComplete(byte[] sidecar) throws Exception {
        return isComplete(sidecar, 120000);
    }
    static boolean isComplete(byte[] sidecar, long maxDuration) throws Exception {
        return duration(sidecar, maxDuration) > 0;
    }
    static long duration(byte[] sidecar, long maxDuration) throws Exception {
        JSONArray rows = new JSONArray("[" + new String(sidecar, StandardCharsets.UTF_8) + "]");
        boolean end = false;
        double duration = -1;
        for (int n = 0; n < rows.length(); n++) {
            JSONObject row = rows.getJSONObject(n);
            JSONArray record = row.optJSONArray("record"), time = row.optJSONArray("duration");
            if (record != null && record.length() >= 2 && "end".equals(record.optString(1))) end = true;
            if (time != null && time.length() >= 2) duration = Math.max(duration, time.optDouble(1, -1));
        }
        if (!end) return 0;
        if (!(duration > 0) || !Double.isFinite(duration)) throw new JSONException("invalid duration");
        if (duration > maxDuration) throw new TooLong();
        return (long) Math.ceil(duration);
    }
}
