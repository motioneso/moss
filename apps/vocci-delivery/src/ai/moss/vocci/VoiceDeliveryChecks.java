package ai.moss.vocci;

import android.content.*;
import java.io.*;
import java.util.*;
import org.json.*;

/** Device assertions for the real AtomicFile journal and Android JSON implementation. */
final class VoiceDeliveryChecks {
    private static void check(boolean value) { DeviceChecks.check(value); }
    private static Context isolated(Context parent, String name) {
        return new ContextWrapper(parent) {
            @Override public File getNoBackupFilesDir() { return new File(parent.getNoBackupFilesDir(), name); }
        };
    }
    private static final class Server implements VoiceDelivery.Port {
        final String source;
        JSONObject snapshot;
        boolean loseResponse = true, disabled;
        int enables;
        Server(String source) { this.source = source; }
        private JSONObject status() throws Exception {
            return new JSONObject().put("id", "11111111-1111-4111-8111-111111111111").put("sourceDeviceId", source)
                .put("enabledAt", "2026-10-20T10:00:00.000Z").put("enabled", !disabled);
        }
        @Override public JSONObject enable(JSONObject input) throws Exception {
            enables++;
            if (snapshot == null) snapshot = new JSONObject(input.toString());
            else check(snapshot.toString().equals(input.toString()));
            if (loseResponse) { loseResponse = false; throw new IOException("lost response"); }
            return status();
        }
        @Override public JSONObject disable(String id) throws Exception { disabled = true; return status(); }
    }
    static void run(Context parent, byte[] packets) throws Exception {
        Context context = isolated(parent, "voice-checks");
        DeliveryStore store = new DeliveryStore(context);
        String old = "amsg_1700000100_old", fresh = "amsg_1700000101_new", uncertain = "amsg_1700000102_stop";
        store.discover(old); // Existing queue entries must never acquire voice intent.
        VoiceDelivery voice = new VoiceDelivery(store); voice.desired(true);
        Server server = new Server(store.state.getString("sourceDeviceId"));
        Map<String, Integer> empty = Collections.emptyMap();
        voice.inventory(empty, server); check(server.enables == 0); // Initial empty != two complete snapshots.
        try { voice.inventory(empty, server); throw new AssertionError("expected lost response"); } catch (IOException expected) { /* Persisted before POST. */ }
        check(voice.state.has("snapshot"));
        String frozenSnapshot = voice.state.getJSONObject("snapshot").toString();
        store = new DeliveryStore(context); voice = new VoiceDelivery(store);
        voice.inventory(Collections.singletonMap("amsg_1700000999_later.opus", 5), server);
        check(server.enables == 2 && server.snapshot.toString().equals(frozenSnapshot));
        check(voice.intent(old) == null);
        JSONObject intent = voice.intent(fresh); check(intent != null && intent.isNull("capturedAt"));
        store.discover(fresh, intent); store.retrieved(fresh, packets, "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); store.freeze(fresh);
        store.discover(uncertain, voice.intent(uncertain)); store.retrieved(uncertain, packets, "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); store.freeze(uncertain);
        byte[] bundle = PrivateFiles.read(store.file(fresh, "bundle.json"), 8192);
        check(PrivateFiles.json(store.file(fresh, "bundle.json")).getInt("version") == 2);
        check(PrivateFiles.json(store.file(fresh, "bundle.json")).isNull("capturedAt"));
        store.retrieved(old, packets, "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); store.freeze(old);
        check(PrivateFiles.json(store.file(old, "bundle.json")).getInt("version") == 1);
        voice.desired(false); voice.synchronize(server); check(server.disabled);
        store = new DeliveryStore(context); store.freeze(fresh);
        check(Arrays.equals(bundle, PrivateFiles.read(store.file(fresh, "bundle.json"), 8192)));
        String requestId = "22222222-2222-4222-8222-222222222222";
        JSONObject accepted = new JSONObject().put("id", "33333333-3333-4333-8333-333333333333").put("intent", "voice-request")
            .put("voiceRequestId", requestId).put("state", "complete");
        store.accepted(fresh, accepted);
        JSONObject chat = new JSONObject().put("id", requestId).put("sourceDeviceId", server.source).put("recordingId", fresh)
            .put("threadId", "44444444-4444-4444-8444-444444444444").put("state", "ready-to-send");
        store.chatStatus(fresh, chat); check(store.entries.getJSONObject(fresh).getString("stage").equals("voice-status"));
        try { store.chatStatus(fresh, new JSONObject(chat.toString()).put("threadId", "other")); throw new AssertionError("identity changed"); }
        catch (DeliveryStore.Conflict expected) { check(expected.getMessage().equals("server_identity_change")); }
        store.chatStatus(fresh, new JSONObject(chat.toString()).put("state", "replied"));
        store.entries.getJSONObject(uncertain).put("stage", "interrupted"); store.save(); store.clearCompleted();
        check(!store.file(fresh, "bundle.json").exists() && store.file(uncertain, "bundle.json").exists());
        check(!store.file(fresh, "audio.wav").exists() && store.file(uncertain, "audio.wav").exists());
        store = new DeliveryStore(context); check(store.contains(fresh) && !store.needsRetrieval(fresh));
        check(store.entries.getJSONObject(fresh).getBoolean("cleared"));

        // Disable during an unknown enrollment outcome resolves that same snapshot, then disables it.
        store = new DeliveryStore(isolated(parent, "voice-disabled-checks")); voice = new VoiceDelivery(store); voice.desired(true);
        server = new Server(store.state.getString("sourceDeviceId")); voice.inventory(empty, server);
        try { voice.inventory(empty, server); throw new AssertionError("expected lost response"); } catch (IOException expected) { /* Simulate process loss. */ }
        voice.desired(false); voice.synchronize(server);
        check(server.enables == 2 && server.disabled && !voice.state.has("enablement") && !voice.state.has("snapshot"));
    }
}
