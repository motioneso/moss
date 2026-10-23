package ai.moss.vocci;

import java.io.*;
import java.security.MessageDigest;
import org.json.*;

/** Frozen manifest and destination survive restarts; HTTP resumes independently of BLE. */
final class ResumableUpload {
    interface Port {
        JSONObject reserveUpload(byte[] manifest) throws Exception;
        JSONObject uploadProgress(String id) throws Exception;
        JSONObject putChunk(String id, String kind, int index, byte[] bytes) throws Exception;
        JSONObject finalizeUpload(String id) throws Exception;
        JSONObject poll(String id) throws Exception;
        JSONObject pollVoice(String id) throws Exception;
    }
    static final int CHUNK_BYTES = 1024 * 1024;
    static final String[] KINDS = {"packets", "sidecar", "wav"};
    static final String[] FILES = {"packets.bin", "sidecar.bin", "audio.wav"};
    static JSONObject describe(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        long length = 0;
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024]; int read;
            while ((read = input.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                hash.update(buffer, 0, read); length += read;
            }
        }
        return new JSONObject().put("byteLength", length).put("sha256", RingAuth.hex(hash.digest()));
    }
    static JSONObject manifest(DeliveryStore store, String id) throws Exception {
        JSONObject intent = store.entries.getJSONObject(id).optJSONObject("voiceIntent");
        JSONObject destination = new JSONObject().put("intent", intent == null ? "meeting" : "voice-request");
        if (intent != null) destination.put("enablementId", intent.getString("enablementId")).put("capturedAt", intent.get("capturedAt"));
        JSONObject value = new JSONObject().put("version", 3).put("sourceDeviceId", store.state.getString("sourceDeviceId"))
            .put("recordingId", id).put("destination", destination);
        for (int k = 0; k < KINDS.length; k++) value.put(KINDS[k], describe(store.file(id, FILES[k])));
        return value;
    }
    static JSONObject deliver(Port client, DeliveryStore store, String id) throws Exception {
        JSONObject entry = store.entries.getJSONObject(id), manifest = PrivateFiles.json(store.file(id, "upload.json"));
        if (manifest.getInt("version") != 3 || !manifest.getString("recordingId").equals(id) ||
            !manifest.getString("sourceDeviceId").equals(store.state.getString("sourceDeviceId"))) throw new DeliveryStore.Conflict("source_identity_change");
        boolean voice = manifest.getJSONObject("destination").getString("intent").equals("voice-request");
        if (voice != entry.has("voiceIntent")) throw new DeliveryStore.Conflict("destination_change");
        for (int k = 0; k < KINDS.length; k++) {
            JSONObject expected = manifest.getJSONObject(KINDS[k]), actual = describe(store.file(id, FILES[k]));
            if (expected.getLong("byteLength") != actual.getLong("byteLength") || !expected.getString("sha256").equals(actual.getString("sha256")))
                throw new DeliveryStore.Conflict("retained_source_changed");
        }
        store.checkDelivery(id);
        JSONObject previous = entry.optJSONObject("uploadProgress");
        JSONObject progress = previous == null ? client.reserveUpload(PrivateFiles.read(store.file(id, "upload.json"), 4096)) : client.uploadProgress(previous.getString("id"));
        store.uploadProgress(id, progress);
        String uploadId = progress.getString("id");
        if (progress.getBoolean("expired")) throw new MossClient.Rejected(410);
        if (!progress.getBoolean("reserved")) throw new DeliveryStore.Conflict("server_storage_not_reserved");
        if (!progress.getBoolean("ready")) {
            for (int k = 0; k < KINDS.length; k++) {
                long length = manifest.getJSONObject(KINDS[k]).getLong("byteLength");
                JSONArray received = progress.getJSONObject("received").getJSONArray(KINDS[k]);
                int count = (int) ((length + CHUNK_BYTES - 1) / CHUNK_BYTES);
                boolean[] present = new boolean[count];
                for (int n = 0; n < received.length(); n++) {
                    int index = received.getInt(n);
                    if (index < 0 || index >= count || present[index]) throw new IOException("invalid_progress");
                    present[index] = true;
                }
                try (RandomAccessFile file = new RandomAccessFile(store.file(id, FILES[k]), "r")) {
                    for (int index = 0; index < count; index++) {
                        if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                        if (present[index]) continue;
                        store.checkDelivery(id);
                        int size = (int) Math.min(CHUNK_BYTES, length - (long) index * CHUNK_BYTES);
                        byte[] bytes = new byte[size]; file.seek((long) index * CHUNK_BYTES); file.readFully(bytes);
                        store.uploadProgress(id, client.putChunk(uploadId, KINDS[k], index, bytes));
                    }
                }
            }
            store.checkDelivery(id);
            store.uploadProgress(id, client.finalizeUpload(uploadId));
        }
        store.checkDelivery(id);
        return voice ? client.pollVoice(uploadId) : client.poll(uploadId);
    }
}
