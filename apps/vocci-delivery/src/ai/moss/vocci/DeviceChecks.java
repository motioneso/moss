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
    private boolean ring, hardware;
    private int httpPort;
    private String linkAction;
    @Override public void onCreate(Bundle args) { ring = "true".equals(args.getString("ring")); hardware = "true".equals(args.getString("hardware")); httpPort = Integer.parseInt(args.getString("httpPort", "0")); linkAction = args.getString("linkAction"); super.onCreate(args); start(); }
    static void check(boolean value) { if (!value) throw new AssertionError("device assertion"); }
    private static void remove(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        file.delete();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (linkAction != null) { LinkChecks.run(getTargetContext(), linkAction); result.putString("result", "PASS"); finish(-1, result); return; }
            if (httpPort > 0) { HttpChecks.run(httpPort); result.putString("httpContract", "json_null_post"); }
            if (hardware) {
                // Explicit non-uploading diagnostic. Refuse a competing delivery connection.
                check(!new DeliveryPreferences(getTargetContext()).enabled());
                JSONObject saved = new SecretStore(getTargetContext()).load();
                try (RingConnection connection = new RingConnection(getTargetContext(), saved)) {
                    java.util.Map<String, Integer> inventory = connection.inventory();
                    long inventoryAt = System.currentTimeMillis();
                    connection.readTelemetry();
                    int recordings = 0;
                    for (String name : inventory.keySet()) if (name.endsWith(".opus")) recordings++;
                    HardwareStatus.publish(getTargetContext(), saved, connection.telemetry, inventoryAt, recordings);
                    result.putBoolean("infoObserved", connection.telemetry.info != null);
                    result.putBoolean("storageObserved", connection.telemetry.storage != null);
                    result.putBoolean("recordingObserved", connection.telemetry.recording != null);
                    check(connection.telemetry.info != null && connection.telemetry.storage != null && connection.telemetry.recording != null);
                    result.putString("result", "PASS"); finish(-1, result); return;
                }
            }
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
                            File source = new File(getTargetContext().getCacheDir(), "verify-source.bin");
                            try {
                                connection.retrieve(name, inventory.get(name), source);
                                java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
                                try (java.io.InputStream input = new java.io.FileInputStream(source)) {
                                    byte[] chunk = new byte[8192]; int read;
                                    while ((read = input.read(chunk)) != -1) digest.update(chunk, 0, read);
                                }
                                check(RingAuth.hex(digest.digest()).equals(expected.getString(name))); verified++;
                            } finally { source.delete(); }
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
            File codecPackets = new File(getTargetContext().getCacheDir(), "codec-packets.bin");
            File codecWav = new File(getTargetContext().getCacheDir(), "codec-audio.wav");
            byte[] wav;
            try {
                PrivateFiles.write(codecPackets, packets); OpusWav.decode(codecPackets, codecWav);
                wav = PrivateFiles.read(codecWav, 3_840_044);
            } finally { codecPackets.delete(); codecWav.delete(); }
            check(wav.length == 3244 && ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).getInt(24) == 16000);
            // Generated 130-second Opus fixture exercises the installed platform codec beyond v1 limits.
            try {
                PrivateFiles.write(codecPackets, output -> {
                    for (int n = 0; n < 6500; n++) output.write(new byte[]{(byte) n, 3, (byte) 0xf8, (byte) 0xff, (byte) 0xfe});
                });
                OpusWav.decode(codecPackets, codecWav, 7200000);
                check(codecWav.length() == 4160044);
                boolean limited = false;
                try { OpusWav.decode(codecPackets, codecWav, 120000); }
                catch (IllegalArgumentException expected) { limited = true; }
                check(limited && codecWav.length() == 4160044); // Failed replacement preserves the published long WAV.
            } finally { codecPackets.delete(); codecWav.delete(); }
            File atomicProbe = new File(getTargetContext().getCacheDir(), "atomic-source-check.bin");
            try {
                PrivateFiles.write(atomicProbe, new byte[]{1,2,3});
                try {
                    PrivateFiles.write(atomicProbe, output -> { output.write(new byte[]{9}); throw new java.io.IOException("interrupted"); });
                    throw new AssertionError("partial source published");
                } catch (java.io.IOException expected) { check(Arrays.equals(PrivateFiles.read(atomicProbe, 3), new byte[]{1,2,3})); }
            } finally { atomicProbe.delete(); }
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
            String[] invalidDurations = {"", ",{\"duration\":[1,0]}", ",{\"duration\":[1,-1]}", ",{\"duration\":[1,\"bad\"]}", ",{\"duration\":[1,\"NaN\"]}"};
            for (int n = 0; n < invalidDurations.length; n++) {
                String invalidDuration = "1700000010_duration" + n;
                byte[] sidecar = ("{\"record\":[1,\"end\"]}" + invalidDurations[n]).getBytes(StandardCharsets.UTF_8);
                store.discover(invalidDuration);
                check(!store.admitSidecar(invalidDuration, sidecar));
                check(store.entries.getJSONObject(invalidDuration).getString("stage").equals("failed"));
                check(store.entries.getJSONObject(invalidDuration).getString("error").equals("sidecar_invalid"));
                check(Arrays.equals(sidecar, PrivateFiles.read(store.file(invalidDuration, "sidecar.bin"), 1024)));
                check(!store.file(invalidDuration, "packets.bin").exists());
            }
            check(store.admitSidecar(id, "{\"record\":[1,\"end\"]},{\"duration\":[1,100]}".getBytes(StandardCharsets.UTF_8)));
            String oversized = "1700000003_long";
            store.discover(oversized);
            check(!store.admitSidecar(oversized, "{\"record\":[1,\"end\"]},{\"duration\":[1,7200001]}".getBytes(StandardCharsets.UTF_8)));
            check(store.entries.getJSONObject(oversized).getString("stage").equals("failed"));
            check(store.entries.getJSONObject(oversized).getString("error").equals("duration_limit"));
            check(!store.file(oversized, "packets.bin").exists());
            String interruptedRead = "1700000004_read";
            store.discover(interruptedRead);
            store.failure(interruptedRead, "ring_file_invalid", false);
            check(store.needsRetrieval(interruptedRead) && !store.retrievalDue(interruptedRead));
            check(store.entries.getJSONObject(interruptedRead).getString("stage").equals("discovered"));
            java.util.List<String> inventoryOrder = Arrays.asList(interruptedRead + ".opus", id + ".opus", "1700000020_new.opus", id + ".json");
            java.util.List<String> healthyFirst = Arrays.asList(id + ".opus", "1700000020_new.opus", interruptedRead + ".opus");
            check(store.retrievalOrder(inventoryOrder).equals(healthyFirst));
            check(new DeliveryStore(isolated).retrievalOrder(inventoryOrder).equals(healthyFirst));
            store.entries.getJSONObject(interruptedRead).put("nextAt", 0);
            check(store.retrievalDue(interruptedRead));
            store.retrieved(interruptedRead, packets, "{}".getBytes(StandardCharsets.UTF_8));
            check(store.entries.getJSONObject(interruptedRead).optInt("attempts") == 0);
            store.activity("session_refresh_required"); check(store.state.getString("outcome").equals("blocked"));
            store.activity("stopped"); check(store.state.getString("activity").equals("stopped"));
            store.retrieved(id, packets, "{\"duration\":[1,100]}".getBytes(StandardCharsets.UTF_8));
            store.freeze(id);
            byte[] frozen = PrivateFiles.read(store.file(id, "upload.json"), 8192);
            DeliveryStore recovered = new DeliveryStore(isolated);
            recovered.freeze(id);
            check(Arrays.equals(frozen, PrivateFiles.read(recovered.file(id, "upload.json"), 8192)));
            check(PrivateFiles.json(recovered.file(id, "upload.json")).getInt("version") == 3);
            check(recovered.state.getString("sourceDeviceId").equals(store.state.getString("sourceDeviceId")));
            UploadChecks.run(isolated, packets);
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
            recovered.httpFailure(conflictId, 409, true);
            check(recovered.entries.getJSONObject(conflictId).getString("stage").equals("failed"));
            check(new DeliveryStore(isolated).entries.getJSONObject(conflictId).getInt("httpStatus") == 409);
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
            VoiceDeliveryChecks.run(isolated, packets);
            RetentionChecks.run(isolated);
            RecoveryChecks.run(isolated);
            result.putString("recovery", "stopped_stays_stopped,boot,update,permission,rejected_background_start");
            result.putString("retention", "grace_period,pending_failed_interrupted_preserved,atomic_sidecars,tombstones,restart");
            remove(isolated.getNoBackupFilesDir());
            result.putString("checks", "keystore_roundtrip,encrypted_storage,tamper_rejected,completed_sidecar,discovered_restart,invalid_file_isolation,ended_invalid_duration,oversized_duration,interrupted_read_retry,healthy_retrieval_priority,blocked_stopped_status,terminal_identity_conflict,platform_opus_100ms,platform_opus_130s,voice_120s_limit,upload_lost_ack_resume,upload_expiry,upload_identity,atomic_file_rollback,frozen_restart,interrupted_attempt,stable_source_identity,retry_exhaustion,owner_switch_rejected,voice_snapshot_recovery,voice_disable_unknown,voice_baseline,v1_unchanged,voice_frozen_restart,voice_uncertain_capture,voice_identity,cleanup_tombstones");
            result.putString("result", "PASS"); finish(-1, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL"); result.putString("class", error.getClass().getSimpleName());
            if (error instanceof MossClient.Rejected) result.putInt("httpStatus", ((MossClient.Rejected) error).status);
            if (ring && error.getMessage() != null && error.getMessage().matches("ring_[a-z_]+")) result.putString("stage", error.getMessage());
            finish(1, result);
        }
    }
}
