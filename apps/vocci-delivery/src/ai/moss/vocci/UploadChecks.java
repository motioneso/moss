package ai.moss.vocci;

import android.content.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

/** Installed-device assertions with a deliberately lossy transport double. */
final class UploadChecks {
    static void check(boolean value) { DeviceChecks.check(value); }
    private static final class Server implements ResumableUpload.Port {
        final String id = "44444444-4444-4444-8444-444444444444";
        String frozen;
        boolean loseReserve = true, loseChunk = true, ready, expired;
        int reserves, packets;
        final JSONObject received = new JSONObject();
        Server() throws Exception { for (String kind : ResumableUpload.KINDS) received.put(kind, new JSONArray()); }
        JSONObject progress() throws Exception { return new JSONObject().put("id", id).put("fingerprint", "a".repeat(64)).put("chunkBytes", ResumableUpload.CHUNK_BYTES)
            .put("expiresAt", "2026-10-23T00:00:00.000Z").put("reserved", true).put("ready", ready).put("expired", expired).put("received", new JSONObject(received.toString())); }
        @Override public JSONObject reserveUpload(byte[] bytes) throws Exception {
            reserves++; String value = new String(bytes, StandardCharsets.UTF_8);
            if (frozen == null) frozen = value; else check(frozen.equals(value));
            if (loseReserve) { loseReserve = false; throw new IOException("lost reserve response"); }
            return progress();
        }
        @Override public JSONObject uploadProgress(String id) throws Exception { check(this.id.equals(id)); return progress(); }
        @Override public JSONObject putChunk(String id, String kind, int index, byte[] bytes) throws Exception {
            check(this.id.equals(id)); received.getJSONArray(kind).put(index);
            if (kind.equals("packets")) packets++;
            if (loseChunk) { loseChunk = false; throw new IOException("lost chunk response"); }
            return progress();
        }
        @Override public JSONObject finalizeUpload(String id) throws Exception { ready = true; return progress(); }
        @Override public JSONObject poll(String id) throws Exception { return new JSONObject().put("id", id).put("meetingId", "55555555-5555-4555-8555-555555555555").put("mode", "normal").put("state", "queued"); }
        @Override public JSONObject pollVoice(String id) throws Exception { throw new AssertionError("destination changed"); }
    }
    static void run(Context parent, byte[] packets) throws Exception {
        Context context = new ContextWrapper(parent) { @Override public File getNoBackupFilesDir() { return new File(parent.getNoBackupFilesDir(), "upload-checks"); } };
        DeliveryStore store = new DeliveryStore(context); String id = "1700000300_resume";
        store.discover(id); store.retrieved(id, packets, "{}".getBytes(StandardCharsets.UTF_8)); store.freeze(id);
        byte[] frozen = PrivateFiles.read(store.file(id, "upload.json"), 4096);
        Server server = new Server();
        try { ResumableUpload.deliver(server, store, id); throw new AssertionError("expected lost reserve"); } catch (IOException expected) { }
        store = new DeliveryStore(context);
        try { ResumableUpload.deliver(server, store, id); throw new AssertionError("expected lost chunk"); } catch (IOException expected) { }
        store = new DeliveryStore(context);
        store.accepted(id, ResumableUpload.deliver(server, store, id));
        check(server.reserves == 2 && server.packets == 1 && server.ready);
        check(new DeliveryStore(context).entries.getJSONObject(id).getString("stage").equals("accepted"));
        check(java.util.Arrays.equals(frozen, PrivateFiles.read(store.file(id, "upload.json"), 4096)));
        try { store.uploadProgress(id, server.progress().put("fingerprint", "b".repeat(64))); throw new AssertionError("changed identity"); }
        catch (DeliveryStore.Conflict expected) { }
        server.ready = false; server.expired = true;
        try { ResumableUpload.deliver(server, store, id); throw new AssertionError("expired upload"); }
        catch (MossClient.Rejected expected) { check(expected.status == 410); }
        for (int version : new int[]{1,2}) {
            String legacy = "170000030" + version + "_legacy";
            store.discover(legacy); store.retrieved(legacy, packets, "{}".getBytes(StandardCharsets.UTF_8));
            JSONObject bundle = new JSONObject().put("version", version).put("retained", "immutable");
            PrivateFiles.json(store.file(legacy, "bundle.json"), bundle);
            store = new DeliveryStore(context); store.freeze(legacy);
            check(PrivateFiles.json(store.file(legacy, "bundle.json")).toString().equals(bundle.toString()));
            check(!store.file(legacy, "upload.json").exists());
        }
        check(CompletedSidecar.isComplete("{\"record\":[1,\"end\"]},{\"duration\":[1,7200000]}".getBytes(StandardCharsets.UTF_8), 7200000));
        try { CompletedSidecar.isComplete("{\"record\":[1,\"end\"]},{\"duration\":[1,120001]}".getBytes(StandardCharsets.UTF_8), 120000); throw new AssertionError("voice duration"); }
        catch (CompletedSidecar.TooLong expected) { }
    }
}
