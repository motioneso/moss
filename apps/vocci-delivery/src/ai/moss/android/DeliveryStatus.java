package ai.moss.android;

import java.io.File;
import java.util.Locale;
import org.json.*;

/** Read-only journal presentation; never constructs the writing DeliveryStore. */
final class DeliveryStatus {
    private static String mib(long bytes) { return String.format(Locale.ROOT, "%.1f MiB", bytes / 1048576.0); }
    private static long size(File file) {
        if (!file.isDirectory()) return file.length();
        long bytes = 0; File[] children = file.listFiles();
        if (children != null) for (File child : children) bytes += size(child);
        return bytes;
    }
    static String storage(File root, JSONObject entries) throws JSONException {
        long queued = 0, failed = 0, completed = 0, reserved = 0;
        java.util.Iterator<String> ids = entries.keys();
        while (ids.hasNext()) {
            String id = ids.next(); JSONObject entry = entries.getJSONObject(id);
            if (!RingProtocol.validName(id + ".opus")) continue;
            long bytes = size(new File(root, id)); String stage = entry.optString("stage");
            if (DeliveryStore.completed(stage)) completed += bytes;
            else if (stage.equals("failed")) failed += bytes;
            else { queued += bytes; reserved += Math.max(0, entry.optLong("storageBudget") - bytes); }
        }
        return "Local audio: " + mib(queued + failed + completed) + " of 2048 MiB" +
            "\nQueued " + mib(queued) + " · Failed " + mib(failed) + " · Completed " + mib(completed) +
            "\nReserved for retrieval/decode: " + mib(reserved) + " · Free: " + mib(root.getUsableSpace()) +
            "\nKeep 150 MiB free. Clear completed local audio to reclaim space.";
    }
    static String upload(File directory, JSONObject entry) throws Exception {
        JSONObject progress = entry.optJSONObject("uploadProgress");
        if (progress == null || entry.optBoolean("cleared")) return "";
        if (progress.optBoolean("expired")) return "Upload expired. Source audio retained; inspect delivery setup before retrying.";
        if (progress.optBoolean("ready")) return "Upload complete · audio retained on Moss";
        JSONObject manifest = PrivateFiles.json(new File(directory, "upload.json"));
        long total = 0, received = 0;
        for (String kind : ResumableUpload.KINDS) {
            long length = manifest.getJSONObject(kind).getLong("byteLength"); total += length;
            JSONArray chunks = progress.getJSONObject("received").getJSONArray(kind);
            for (int n = 0; n < chunks.length(); n++) received += Math.max(0, Math.min(ResumableUpload.CHUNK_BYTES, length - (long) chunks.getInt(n) * ResumableUpload.CHUNK_BYTES));
        }
        return "Uploaded " + (total == 0 ? 0 : Math.min(100, received * 100 / total)) + "% · " + mib(received) + " / " + mib(total) +
            "\nMissing chunks resume after reconnect. Reservation expires: " + progress.optString("expiresAt");
    }
}
