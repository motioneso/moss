package ai.moss.vocci;

import android.app.Instrumentation;
import android.os.Bundle;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONObject;

/** Generated content only. Refuses every package except the disposable upgrade proof. */
public final class UpgradeFixture extends Instrumentation {
    private Bundle arguments;
    private static final String PACKAGE = "ai.moss.vocci.upgradeproof";
    @Override public void onCreate(Bundle args) { arguments = args; super.onCreate(args); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            check(PACKAGE.equals(getTargetContext().getPackageName()), "disposable_package_required");
            if ("init".equals(arguments.getString("mode"))) initialize();
            verify();
            result.putString("result", "PASS");
            result.putString("checks", "generated_config_decryptable_and_pending_frozen_failed_interrupted_complete_voice_retained");
            finish(-1, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL");
            result.putString("check", error instanceof AssertionError ? error.getMessage() : error.getClass().getSimpleName());
            finish(1, result);
        }
    }
    private void initialize() throws Exception {
        File root = getTargetContext().getNoBackupFilesDir();
        check(!new SecretStore(getTargetContext()).exists() && !new File(root, "delivery/state.json").exists(), "fresh_fixture_required");
        int port = Integer.parseInt(arguments.getString("port"));
        check(port >= 5180 && port <= 5299, "claimed_dev_port_required");
        JSONObject config = new JSONObject().put("origin", "https://127.0.0.1:" + port)
            .put("ownerId", "00000000-0000-4000-8000-000000000001").put("accountName", "Generated upgrade fixture")
            .put("credential", "vr1_" + "A".repeat(43)).put("address", "02:00:00:00:00:01")
            .put("sn", "synthetic-upgrade-ring").put("deviceId", "synthetic-upgrade-device").put("bindKey", "synthetic-upgrade-key");
        new SecretStore(getTargetContext()).save(config);
        DeliveryPreferences choices = new DeliveryPreferences(getTargetContext());
        String enabled = arguments.getString("enabled", "false");
        check(enabled.equals("true") || enabled.equals("false"), "explicit_enabled_choice_required");
        choices.enabled(Boolean.parseBoolean(enabled)); choices.autoCleanup(false);
        DeliveryStore store = new DeliveryStore(getTargetContext());
        byte[] silence = new byte[25];
        for (int n = 0; n < 5; n++) {
            silence[n * 5] = (byte) n; silence[n * 5 + 1] = 3;
            silence[n * 5 + 2] = (byte) 0xf8; silence[n * 5 + 3] = (byte) 0xff; silence[n * 5 + 4] = (byte) 0xfe;
        }
        store.discover("1700000000_pending");
        PrivateFiles.write(store.file("1700000000_pending", "packets.bin"), Arrays.copyOf(silence, 8));
        for (String id : new String[]{"1700000001_ready", "amsg_1700000002_voice"}) {
            JSONObject intent = id.startsWith("amsg_") ? new JSONObject()
                .put("enablementId", "00000000-0000-4000-8000-000000000002").put("capturedAt", JSONObject.NULL) : null;
            store.discover(id, intent);
            store.retrieved(id, silence, "{}".getBytes(StandardCharsets.UTF_8));
            store.freeze(id);
        }
        store.discover("1700000003_failed"); store.failure("1700000003_failed", "generated_failure", true);
        store.discover("amsg_1700000004_stopped");
        store.entries.getJSONObject("amsg_1700000004_stopped").put("stage", "interrupted");
        store.discover("1700000005_complete");
        store.accepted("1700000005_complete", new JSONObject().put("id", "00000000-0000-4000-8000-000000000003")
            .put("meetingId", "00000000-0000-4000-8000-000000000004").put("mode", "normal").put("state", "complete"));
        VoiceDelivery voice = new VoiceDelivery(store); voice.desired(true);
        voice.state.put("baseline", new JSONObject().put("amsg_1700000002_voice", true));
        voice.state.put("enablement", new JSONObject().put("id", "00000000-0000-4000-8000-000000000002")
            .put("sourceDeviceId", store.state.getString("sourceDeviceId")).put("enabled", true)
            .put("enabledAt", "2026-10-23T00:00:00.000Z"));
        store.activity("stopped");
    }
    private void verify() throws Exception {
        JSONObject config = new SecretStore(getTargetContext()).load();
        check(config.getString("deviceId").equals("synthetic-upgrade-device"), "generated_config_only");
        check(config.getString("credential").equals("vr1_" + "A".repeat(43)), "keystore_plaintext_roundtrip");
        check(config.getString("origin").matches("https://127\\.0\\.0\\.1:52[0-9]{2}|https://127\\.0\\.0\\.1:51[89][0-9]"), "closed_loopback_origin_only");
        JSONObject state = PrivateFiles.json(new File(getTargetContext().getNoBackupFilesDir(), "delivery/state.json"));
        JSONObject entries = state.getJSONObject("entries");
        check(entries.length() == 6, "six_generated_entries_retained");
        check(entries.getJSONObject("1700000000_pending").getString("stage").equals("discovered"), "pending_download_retained");
        check(entries.getJSONObject("1700000001_ready").getString("stage").equals("ready"), "normal_frozen_stage_retained");
        check(entries.getJSONObject("amsg_1700000002_voice").getString("stage").equals("ready"), "voice_frozen_stage_retained");
        check(entries.getJSONObject("1700000003_failed").getString("stage").equals("failed"), "failed_stage_retained");
        check(entries.getJSONObject("amsg_1700000004_stopped").getString("stage").equals("interrupted"), "interrupted_stage_retained");
        check(entries.getJSONObject("1700000005_complete").getString("stage").equals("complete"), "completed_stage_retained");
        check(state.getJSONObject("voice").getBoolean("desired"), "hold_choice_retained");
        check(!new DeliveryPreferences(getTargetContext()).autoCleanup(), "cleanup_disabled");
    }
    private static void check(boolean value, String name) { if (!value) throw new AssertionError(name); }
}
