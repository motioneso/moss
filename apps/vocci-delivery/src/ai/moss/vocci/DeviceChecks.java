package ai.moss.vocci;

import android.app.Instrumentation;
import android.os.Bundle;
import java.io.File;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONObject;

/** Explicit developer instrumentation; optional ring reads, no control or private output. */
public final class DeviceChecks extends Instrumentation {
    private boolean ring;
    @Override public void onCreate(Bundle args) { ring = "true".equals(args.getString("ring")); super.onCreate(args); start(); }
    static void check(boolean value) { if (!value) throw new AssertionError("device assertion"); }
    private static void remove(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        file.delete();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (ring) {
                try (RingConnection connection = new RingConnection(getTargetContext(), new SecretStore(getTargetContext()).load())) {
                    java.util.Map<String, Integer> inventory = connection.inventory();
                    result.putInt("inventoryCount", inventory.size());
                    File expectedFile = new File(getTargetContext().getFilesDir(), "verify.json");
                    if (expectedFile.exists()) {
                        JSONObject expected = PrivateFiles.json(expectedFile); int verified = 0;
                        java.util.Iterator<String> names = expected.keys();
                        while (names.hasNext()) {
                            String name = names.next();
                            check(inventory.containsKey(name));
                            byte[] bytes = connection.retrieve(name, inventory.get(name));
                            String hash = RingAuth.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
                            check(hash.equals(expected.getString(name))); verified++;
                        }
                        result.putInt("verifiedSourceFiles", verified);
                        expectedFile.delete();
                    }
                    result.putString("result", "PASS"); finish(-1, result); return;
                }
            }
            File testFile = new File(getTargetContext().getNoBackupFilesDir(), "check.enc");
            SecretStore secrets = new SecretStore(getTargetContext(), "moss-vocci-test", "check.enc");
            JSONObject config = new JSONObject().put("secret", "synthetic-keystore-check");
            secrets.save(config); check(secrets.load().getString("secret").equals("synthetic-keystore-check"));
            byte[] encrypted = PrivateFiles.read(testFile, 16384);
            check(!new String(encrypted, StandardCharsets.UTF_8).contains("synthetic-keystore-check"));
            encrypted[encrypted.length - 1] ^= 1; PrivateFiles.write(testFile, encrypted);
            boolean rejected = false;
            try { secrets.load(); } catch (Exception expected) { rejected = true; }
            check(rejected); testFile.delete();
            check(!CompletedSidecar.isComplete("{\"record\":[1,\"start\"]}".getBytes(StandardCharsets.UTF_8)));
            check(CompletedSidecar.isComplete("{\"record\":[1,\"end\"]},{\"duration\":[1,5880]}".getBytes(StandardCharsets.UTF_8)));
            // RFC 6716 valid 20ms Opus silence, five packets. Codec must produce 100ms.
            byte[] packets = new byte[25];
            for (int n = 0; n < 5; n++) {
                packets[n * 5] = (byte) n; packets[n * 5 + 1] = 3;
                packets[n * 5 + 2] = (byte) 0xf8; packets[n * 5 + 3] = (byte) 0xff; packets[n * 5 + 4] = (byte) 0xfe;
            }
            byte[] wav = OpusWav.decode(packets);
            check(wav.length == 3244 && ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).getInt(24) == 16000);
            android.content.Context isolated = new android.content.ContextWrapper(getTargetContext()) {
                @Override public File getNoBackupFilesDir() { return new File(super.getNoBackupFilesDir(), "device-checks"); }
            };
            remove(isolated.getNoBackupFilesDir());
            DeliveryStore store = new DeliveryStore(isolated);
            String id = "1700000000_test";
            store.discover(id);
            check(new DeliveryStore(isolated).needsRetrieval(id));
            String invalid = "1700000001_bad";
            store.discover(invalid);
            check(!store.admitSidecar(invalid, "not-json".getBytes(StandardCharsets.UTF_8)));
            check(!store.needsRetrieval(invalid));
            check(store.entries.getJSONObject(invalid).getString("error").equals("sidecar_invalid"));
            check(store.needsRetrieval(id));
            check(store.admitSidecar(id, "{\"record\":[1,\"end\"]},{\"duration\":[1,100]}".getBytes(StandardCharsets.UTF_8)));
            store.activity("session_refresh_required"); check(store.state.getString("outcome").equals("blocked"));
            store.activity("stopped"); check(store.state.getString("activity").equals("stopped"));
            store.retrieved(id, packets, "{\"duration\":[1,100]}".getBytes(StandardCharsets.UTF_8));
            store.freeze(id);
            byte[] frozen = PrivateFiles.read(store.file(id, "bundle.json"), 8192);
            DeliveryStore recovered = new DeliveryStore(isolated);
            recovered.freeze(id);
            check(Arrays.equals(frozen, PrivateFiles.read(recovered.file(id, "bundle.json"), 8192)));
            check(recovered.state.getString("sourceDeviceId").equals(store.state.getString("sourceDeviceId")));
            String conflictId = "1700000002_conflict";
            recovered.retrieved(conflictId, packets, "{}".getBytes(StandardCharsets.UTF_8));
            JSONObject accepted = new JSONObject().put("id", "11111111-1111-4111-8111-111111111111")
                .put("meetingId", "22222222-2222-4222-8222-222222222222").put("mode", "normal").put("state", "queued");
            recovered.accepted(conflictId, accepted);
            boolean conflict = false;
            try { recovered.accepted(conflictId, new JSONObject(accepted.toString()).put("id", "different")); }
            catch (DeliveryStore.Conflict expected) { conflict = expected.getMessage().equals("server_identity_change"); }
            check(conflict);
            conflict = false;
            try { recovered.accepted(conflictId, new JSONObject(accepted.toString()).put("mode", "voice-request")); }
            catch (DeliveryStore.Conflict expected) { conflict = expected.getMessage().equals("server_mode_change"); }
            check(conflict);
            recovered.failure(conflictId, "server_identity_change", true);
            check(new DeliveryStore(isolated).entries.getJSONObject(conflictId).getString("error").equals("server_identity_change"));
            recovered.beginAttempt(id);
            recovered.abandonAttempt(id);
            check(recovered.entries.getJSONObject(id).optInt("attempts") == 0);
            recovered.beginAttempt(id);
            DeliveryStore interrupted = new DeliveryStore(isolated);
            check(interrupted.entries.getJSONObject(id).optInt("attempts") == 1);
            interrupted.failure(id, "ambiguous_upload", false);
            check(interrupted.entries.getJSONObject(id).optInt("attempts") == 1);
            for (int n = 1; n < RetryPolicy.MAX_ATTEMPTS; n++) interrupted.failure(id, "synthetic", false);
            recovered = new DeliveryStore(isolated);
            check(recovered.entries.getJSONObject(id).getString("stage").equals("failed"));
            JSONObject identity = new JSONObject().put("address", "test").put("sn", "test").put("deviceId", "test").put("origin", "https://example.test").put("ownerId", "test");
            SecretStore.assertSameIdentity(identity, new JSONObject(identity.toString()));
            rejected = false;
            try { SecretStore.assertSameIdentity(identity, new JSONObject(identity.toString()).put("ownerId", "other")); }
            catch (IllegalArgumentException expected) { rejected = true; }
            check(rejected);
            remove(isolated.getNoBackupFilesDir());
            result.putString("checks", "keystore_roundtrip,encrypted_storage,tamper_rejected,completed_sidecar,discovered_restart,invalid_file_isolation,blocked_stopped_status,terminal_identity_conflict,platform_opus_100ms,frozen_restart,interrupted_attempt,stable_source_identity,retry_exhaustion,owner_switch_rejected");
            result.putString("result", "PASS"); finish(-1, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL"); result.putString("class", error.getClass().getSimpleName());
            if (ring && error.getMessage() != null && error.getMessage().matches("ring_[a-z_]+")) result.putString("stage", error.getMessage());
            finish(1, result);
        }
    }
}
