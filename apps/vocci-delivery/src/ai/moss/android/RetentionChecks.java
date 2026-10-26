package ai.moss.android;

import android.content.Context;
import java.io.File;
import org.json.JSONObject;

/** Real journal/filesystem checks: grace periods, interruption and pending evidence. */
final class RetentionChecks {
    static void run(Context context) throws Exception {
        DeliveryStore store = new DeliveryStore(context);
        long now = System.currentTimeMillis(), week = 7L * 24 * 60 * 60 * 1000;
        String[] stages = {"complete", "replied", "no-speech", "accepted", "failed", "interrupted", "voice-status"};
        for (int i = 0; i < stages.length; i++) {
            String id = "170001000" + i + "_retention";
            store.discover(id);
            store.entries.getJSONObject(id).put("stage", stages[i]).put("completedAt", now - week);
            PrivateFiles.write(store.file(id, "packets.bin"), new byte[]{1, 2});
            PrivateFiles.write(store.file(id, "audio.wav.new"), new byte[]{3});
        }
        String recent = "1700010010_recent", legacy = "1700010011_legacy";
        for (String id : new String[]{recent, legacy}) {
            store.discover(id); store.entries.getJSONObject(id).put("stage", "complete");
            PrivateFiles.write(store.file(id, "packets.bin"), new byte[]{1});
        }
        store.entries.getJSONObject(recent).put("completedAt", now - week + 1); store.save();
        store = new DeliveryStore(context); store.clearExpiredCompleted(now);
        for (int i = 0; i < stages.length; i++) {
            String id = "170001000" + i + "_retention";
            boolean completed = DeliveryStore.completed(stages[i]);
            DeviceChecks.check(store.entries.getJSONObject(id).optBoolean("cleared") == completed);
            DeviceChecks.check(store.file(id, "packets.bin").exists() != completed);
            DeviceChecks.check(store.file(id, "audio.wav.new").exists() != completed);
            DeviceChecks.check(store.contains(id) && !store.needsRetrieval(id));
        }
        DeviceChecks.check(store.file(recent, "packets.bin").exists() && store.file(legacy, "packets.bin").exists());
        store = new DeliveryStore(context);
        DeviceChecks.check(store.entries.getJSONObject(legacy).getLong("completedAt") == now);
        store.clearExpiredCompleted(now + week);
        DeviceChecks.check(!store.file(legacy, "packets.bin").exists());
    }
}
