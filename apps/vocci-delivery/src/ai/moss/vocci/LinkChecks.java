package ai.moss.vocci;

import android.content.Context;
import android.content.ContextWrapper;
import java.io.File;
import org.json.JSONObject;

/** Explicit isolated live-proof surface; excluded from release builds. No ring I/O. */
final class LinkChecks {
    static void run(Context context, String action) throws Exception {
        if (!context.getPackageName().endsWith(".dailyproof")) throw new IllegalStateException("proof_package_required");
        SecretStore secrets = new SecretStore(context);
        if (action.equals("provision")) { secrets.provision(context); new DeliveryStore(context); }
        JSONObject config = secrets.load(), value = new JSONObject().put("ownerId", config.getString("ownerId"))
            .put("hasCookie", config.has("cookie")).put("hasCredential", config.has("credential"))
            .put("autoCleanup", new DeliveryPreferences(context).autoCleanup());
        MossLink link = new MossLink(context);
        if (link.pending()) value.put("approvalPath", link.attempt().getString("approvalPath"));
        if (action.equals("verify")) {
            DeviceChecks.check(!config.has("cookie") && config.getString("credential").matches("vr1_[A-Za-z0-9_-]{43}"));
            DeviceChecks.check(new MossClient(config).owner().equals(config.getString("ownerId")));
        }
        if (action.equals("upload") || action.equals("upload-voice")) {
            Context isolated = new ContextWrapper(context) {
                @Override public File getNoBackupFilesDir() { return new File(super.getNoBackupFilesDir(), "link-proof"); }
            };
            DeliveryStore store = new DeliveryStore(isolated);
            boolean voice = action.equals("upload-voice");
            MossClient client = new MossClient(config);
            String id = voice ? "amsg_1700050000_linkproof" : "1700050000_linkproof";
            if (voice && !store.contains(id)) {
                VoiceDelivery enrollment = new VoiceDelivery(store);
                enrollment.desired(true);
                enrollment.inventory(java.util.Collections.emptyMap(), client);
                enrollment.inventory(java.util.Collections.emptyMap(), client);
                store.discover(id, enrollment.intent(id));
            }
            byte[] packets = new byte[25];
            for (int n = 0; n < 5; n++) {
                packets[n * 5] = (byte) n; packets[n * 5 + 1] = 3;
                packets[n * 5 + 2] = (byte) 0xf8; packets[n * 5 + 3] = (byte) 0xff; packets[n * 5 + 4] = (byte) 0xfe;
            }
            if (store.needsRetrieval(id)) {
                store.retrieved(id, packets, "{\"record\":[\"1700050000000\",\"start\"]},{\"record\":[\"1700050000100\",\"end\"]},{\"duration\":[\"1700050000100\",\"100\"]}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                store.freeze(id);
            }
            JSONObject status = ResumableUpload.deliver(client, store, id);
            value.put("importId", status.getString("id"));
            if (!voice) value.put("meetingId", status.getString("meetingId"));
        }
        PrivateFiles.json(new File(context.getFilesDir(), "link-proof-result.json"), value);
    }
}
