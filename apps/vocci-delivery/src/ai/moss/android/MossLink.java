package ai.moss.android;

import android.content.Context;
import android.os.Build;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.Instant;
import org.json.JSONObject;

/** Browser approval never exposes a browser session to this client. All methods run off UI. */
final class MossLink {
    private final SecretStore pending, config;
    MossLink(Context context) {
        pending = new SecretStore(context, "moss-vocci-link", "link.enc"); config = new SecretStore(context);
    }
    boolean pending() { return pending.exists(); }
    JSONObject attempt() throws Exception { return pending.load(); }
    String begin() throws Exception {
        if (pending()) return attempt().getString("approvalPath");
        JSONObject saved = config.load();
        JSONObject attempt = prepare(saved.getString("origin"));
        acceptAttempt(attempt, MossClient.linkRequest(attempt.getString("origin"), "/api/companion/pair", requestBody(attempt)));
        pending.save(attempt);
        return attempt.getString("approvalPath");
    }
    static JSONObject prepare(String origin) throws Exception {
        byte[] entropy = new byte[32]; new SecureRandom().nextBytes(entropy);
        String verifier = Base64.encodeToString(entropy, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return new JSONObject().put("origin", MossClient.origin(origin)).put("verifier", verifier);
    }
    static JSONObject requestBody(JSONObject attempt) throws Exception {
        String hash = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(attempt.getString("verifier").getBytes(StandardCharsets.UTF_8)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return new JSONObject().put("deviceName", "Moss ring · Android").put("platform", "android").put("appVersion", "1.0.0")
            .put("osVersion", Build.VERSION.RELEASE.substring(0, Math.min(32, Build.VERSION.RELEASE.length()))).put("verifierHash", hash);
    }
    static void acceptAttempt(JSONObject attempt, JSONObject response) throws Exception {
        String attemptId = MossClient.uuid(response.getString("attemptId"));
        String path = response.getString("approvalPath");
        if (!path.matches("/link/trail-marker#code=[A-Za-z0-9_-]{32}")) throw new IllegalArgumentException("approval_path");
        Instant.parse(response.getString("expiresAt"));
        attempt.put("attemptId", attemptId).put("approvalPath", path).put("expiresAt", response.getString("expiresAt"));
    }
    static JSONObject proof(JSONObject attempt) throws Exception {
        return new JSONObject().put("attemptId", attempt.getString("attemptId")).put("verifier", attempt.getString("verifier"));
    }
    boolean check() throws Exception {
        if (!pending()) return false;
        JSONObject attempt = pending.load();
        if (Instant.parse(attempt.getString("expiresAt")).isBefore(Instant.now())) throw new IllegalStateException("link_expired");
        JSONObject response = MossClient.linkRequest(attempt.getString("origin"), "/api/companion/pair/redeem", proof(attempt));
        if (response.optString("status").equals("pending")) return false;
        JSONObject saved = config.load(), updated = new JSONObject(saved.toString());
        if (!saved.getString("origin").equals(attempt.getString("origin"))) throw new IllegalStateException("configuration_identity_change");
        updated.remove("cookie"); updated.put("credential", response.getString("credential"));
        updated.put("ownerId", MossClient.uuid(response.getJSONObject("account").getString("id")));
        updated.put("accountName", response.getJSONObject("account").getString("name"));
        updated.put("credentialExpiresAt", response.getString("expiresAt"));
        try {
            SecretStore.assertSameIdentity(saved, updated);
            if (!new MossClient(updated).owner().equals(saved.getString("ownerId"))) throw new IllegalStateException("owner_mismatch");
            if (saved.has("credential")) new MossClient(saved).logout();
            config.save(updated);
        } catch (Exception rejected) {
            // A wrong-account approval must not leave an unintended working phone behind.
            cancel(); throw rejected;
        }
        pending.delete(); return true;
    }
    void cancel() throws Exception {
        if (!pending()) return;
        JSONObject attempt = pending.load();
        MossClient.linkRequest(attempt.getString("origin"), "/api/companion/pair/cancel", proof(attempt));
        pending.delete();
    }
    void disconnect() throws Exception {
        cancel();
        JSONObject saved = config.load();
        new MossClient(saved).logout();
        saved.remove("credential"); saved.remove("cookie"); saved.remove("credentialExpiresAt");
        config.save(saved); // Ring keys, owner pin and local queue survive.
    }
}
