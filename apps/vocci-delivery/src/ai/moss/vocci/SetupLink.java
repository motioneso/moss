package ai.moss.vocci;

import android.content.Context;
import java.io.File;
import java.time.Instant;
import org.json.JSONObject;

/** Serialized first-install account transaction. It never publishes delivery configuration. */
final class SetupLink {
    // Activity recreation can overlap an old worker's HTTP request. Serialize
    // every transaction across instances and refresh the disk record on entry.
    private static final Object TRANSACTION = new Object();
    enum Phase { EMPTY, APPROVAL, CONFIRMING, LINKED, CLEANUP, COMMITTED, RECOVERY }
    static final class Status {
        final Phase phase;
        final String origin, accountName;
        Status(Phase phase, JSONObject record) {
            this.phase = phase; origin = record.optString("origin"); accountName = record.optString("accountName");
        }
    }
    interface Port {
        JSONObject request(String origin, String path, JSONObject body) throws Exception;
        String owner(JSONObject configuration) throws Exception;
        void logout(JSONObject configuration) throws Exception;
    }
    private static final Port NETWORK = new Port() {
        public JSONObject request(String origin, String path, JSONObject body) throws Exception { return MossClient.linkRequest(origin, path, body); }
        public String owner(JSONObject configuration) throws Exception { return new MossClient(configuration).owner(); }
        public void logout(JSONObject configuration) throws Exception { new MossClient(configuration).logout(); }
    };
    private final SecretStore staged, committed;
    private final File deliveryState;
    private final Port port;
    private JSONObject record;
    SetupLink(Context context) throws Exception {
        this(new SecretStore(context, "moss-vocci-setup", "setup.enc"), new SecretStore(context),
            new File(context.getNoBackupFilesDir(), "delivery/state.json"), NETWORK);
    }
    SetupLink(SecretStore staged, SecretStore committed, File deliveryState, Port port) throws Exception {
        this.staged = staged; this.committed = committed; this.deliveryState = deliveryState; this.port = port;
        synchronized (TRANSACTION) { refresh(); reconcile(); }
    }
    private void refresh() throws Exception { record = staged.exists() ? staged.load() : new JSONObject(); }
    private void save() throws Exception { staged.save(record); }
    private boolean reconcile() throws Exception {
        if (!committed.exists()) return false;
        JSONObject active = committed.load();
        try {
            for (String field : new String[]{"address", "sn", "deviceId", "bindKey"}) {
                Object value = active.opt(field);
                if (!(value instanceof String) || ((String) value).isEmpty() || ((String) value).length() > 256 ||
                    !value.equals(((String) value).trim()) || ((String) value).matches("(?s).*\\p{Cntrl}.*")) throw new IllegalArgumentException();
            }
            if (!active.getString("address").equals(RingAuth.canonicalMac(active.getString("address")))) throw new IllegalArgumentException();
            MossClient.uuid(active.getString("ownerId")); new MossClient(active);
        } catch (Exception malformed) { throw new IllegalStateException("setup_recovery_required"); }
        // Do not revoke a credential adopted by the complete configuration just
        // before process death. An unrelated/corrupt configuration needs recovery.
        if (staged.exists()) {
            if (!sameCredential(active, record)) throw new IllegalStateException("setup_recovery_required");
            staged.delete(); record = new JSONObject();
        }
        return true;
    }
    private static boolean sameCredential(JSONObject active, JSONObject candidate) {
        for (String field : new String[]{"origin", "ownerId", "credential"})
            if (candidate.optString(field).isEmpty() || !candidate.optString(field).equals(active.optString(field))) return false;
        return true;
    }
    Status status() throws Exception {
        synchronized (TRANSACTION) { refresh(); return savedStatus(); }
    }
    private Status savedStatus() throws Exception {
        if (reconcile()) return new Status(Phase.COMMITTED, new JSONObject());
        if (!staged.exists()) return new Status(deliveryState.exists() ? Phase.RECOVERY : Phase.EMPTY, record);
        Phase phase;
        if (record.optBoolean("cleanupRequested")) phase = Phase.CLEANUP;
        else if (record.has("credential")) phase = !record.has("ownerId") ? Phase.CLEANUP :
            record.optBoolean("ownerConfirmed") ? Phase.LINKED : Phase.CONFIRMING;
        else phase = record.optBoolean("redemptionStarted") || !record.has("attemptId") ? Phase.CLEANUP : Phase.APPROVAL;
        return new Status(phase, record);
    }
    private void requireUnconfigured() throws Exception {
        if (reconcile()) throw new IllegalStateException("setup_already_configured");
        if (deliveryState.exists()) throw new IllegalStateException("setup_recovery_required");
    }
    String begin(String origin) throws Exception {
        synchronized (TRANSACTION) { refresh(); return beginSaved(origin); }
    }
    private String beginSaved(String origin) throws Exception {
        requireUnconfigured(); origin = MossClient.origin(origin);
        if (staged.exists()) {
            if (!record.getString("origin").equals(origin)) throw new IllegalStateException("setup_origin_pinned");
            if (savedStatus().phase != Phase.APPROVAL) throw new IllegalStateException("setup_cleanup_required");
            checkExpiry(); return origin + record.getString("approvalPath");
        }
        record = MossLink.prepare(origin); save();
        MossLink.acceptAttempt(record, port.request(origin, "/api/companion/pair", MossLink.requestBody(record)));
        save(); return origin + record.getString("approvalPath");
    }
    private void checkExpiry() throws Exception {
        if (!Instant.parse(record.getString("expiresAt")).isAfter(Instant.now())) throw new IllegalStateException("link_expired");
    }
    boolean check() throws Exception {
        synchronized (TRANSACTION) { refresh(); return checkSaved(); }
    }
    private boolean checkSaved() throws Exception {
        requireUnconfigured();
        Phase phase = savedStatus().phase;
        if (phase == Phase.CLEANUP || phase == Phase.EMPTY) throw new IllegalStateException("setup_cleanup_required");
        if (!record.has("credential")) {
            checkExpiry();
            record.put("redemptionStarted", true); save();
            JSONObject response = port.request(record.getString("origin"), "/api/companion/pair/redeem", MossLink.proof(record));
            if ("pending".equals(response.optString("status"))) {
                record.remove("redemptionStarted"); save(); return false;
            }
            String credential = response.getString("credential");
            if (!credential.matches("vr1_[A-Za-z0-9_-]{43}")) throw new IllegalStateException("setup_response_invalid");
            // Retain the minted credential before parsing account data or making
            // another request. The attempt proof remains a lost-response fallback.
            record.put("credential", credential); save();
            JSONObject account = response.getJSONObject("account");
            String name = account.getString("name");
            if (name.length() > 256 || name.matches("(?s).*\\p{Cntrl}.*")) throw new IllegalStateException("setup_response_invalid");
            Instant.parse(response.getString("expiresAt"));
            record.put("ownerId", MossClient.uuid(account.getString("id"))).put("accountName", name)
                .put("credentialExpiresAt", response.getString("expiresAt")); save();
        }
        if (!record.has("ownerId")) throw new IllegalStateException("setup_cleanup_required");
        if (!record.getString("ownerId").equals(port.owner(record))) {
            record.put("cleanupRequested", true); save(); throw new IllegalStateException("owner_mismatch");
        }
        record.put("ownerConfirmed", true); save(); return true;
    }
    void cancel() throws Exception {
        synchronized (TRANSACTION) { refresh(); cancelSaved(); }
    }
    private void cancelSaved() throws Exception {
        if (reconcile() || !staged.exists()) return;
        record.put("cleanupRequested", true);
        for (String field : new String[]{"accountName", "credentialExpiresAt", "ownerConfirmed", "approvalPath", "expiresAt", "redemptionStarted"}) record.remove(field);
        save();
        if (record.has("credential")) {
            port.logout(record);
            record.remove("credential"); record.remove("ownerId"); save();
        }
        if (record.has("attemptId")) port.request(record.getString("origin"), "/api/companion/pair/cancel", MossLink.proof(record));
        // With no attempt ID, no approval URL was handed to the browser and no
        // redeem could have been made. The unused server attempt simply expires.
        staged.delete(); record = new JSONObject();
    }
}
