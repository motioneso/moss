package ai.moss.android;

import android.app.Instrumentation;
import android.os.Bundle;
import java.io.File;
import java.io.IOException;
import java.time.Instant;
import org.json.JSONObject;

/** Installed synthetic transaction checks, with dedicated stores and no physical ring connection. */
public final class SetupRingChecks extends Instrumentation {
    private static final String ORIGIN = "https://moss.example.test";
    private static final String OWNER = "00000000-0000-4000-8000-000000000001";
    private static final String ATTEMPT = "00000000-0000-4000-8000-000000000002";
    private static final String CREDENTIAL = "vr1_" + "A".repeat(43);
    private SecretStore stage, config;
    private File delivery;
    private int passed;
    interface Work { void run() throws Exception; }
    private final class Fake implements SetupLink.Port, SetupLink.RingProof {
        int proofs, owners, logouts;
        boolean failProof, offlineOwner, revoked;
        String owner = OWNER;
        JSONObject observed;
        Work duringProof;
        public JSONObject request(String origin, String path, JSONObject body) throws Exception {
            check(origin.equals(ORIGIN), "origin_pinned");
            if (path.equals("/api/companion/pair")) return new JSONObject().put("attemptId", ATTEMPT)
                .put("approvalPath", "/link/trail-marker#code=" + "b".repeat(32)).put("expiresAt", Instant.now().plusSeconds(600).toString());
            if (path.equals("/api/companion/pair/redeem")) return new JSONObject().put("credential", CREDENTIAL)
                .put("expiresAt", Instant.now().plusSeconds(86400).toString())
                .put("account", new JSONObject().put("id", OWNER).put("name", "Synthetic ring owner"));
            check(path.equals("/api/companion/pair/cancel"), "expected_cancel_route"); return new JSONObject();
        }
        public String owner(JSONObject value) throws Exception {
            owners++;
            check(value.length() == 3 && value.getString("credential").equals(CREDENTIAL) && value.getString("origin").equals(ORIGIN), "moss_receives_account_fields_only");
            if (offlineOwner) throw new IOException("offline");
            if (revoked) throw new MossClient.Rejected(401);
            return owner;
        }
        public void logout(JSONObject value) throws Exception {
            check(!value.has("binding"), "cancel_drops_candidate_before_network"); logouts++;
            if (offlineOwner) throw new IOException("offline");
        }
        public void verify(JSONObject value) throws Exception {
            proofs++; observed = value;
            check(value.length() == 4 && !config.exists(), "proof_precedes_configuration");
            if (duringProof != null) duringProof.run();
            if (failProof) throw new IOException("ring_identity_or_key_rejected");
        }
    }
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        stage = new SecretStore(getTargetContext(), "setup-ring-stage", "setup-ring-stage.enc");
        config = new SecretStore(getTargetContext(), "setup-ring-config", "setup-ring-config.enc");
        delivery = new File(getTargetContext().getNoBackupFilesDir(), "setup-ring-delivery.json");
        Bundle result = new Bundle();
        try {
            reset(); prerequisites(); reset(); selectionAndCommit(); reset(); malformedSelection(); reset(); proofRetry();
            reset(); ownerChecks(); reset(); interruptedCommit(); reset(); conflictingCommit(); reset(); queueAppears();
            reset(); offlineCancellation(); reset(); staleController(); reset(); changeSelection();
            result.putString("result", "PASS"); result.putInt("contracts", passed); finish(-1, result);
        } catch (Throwable failure) {
            result.putString("result", "FAIL"); result.putString("check", failure instanceof AssertionError ? failure.getMessage() : failure.getClass().getSimpleName()); finish(1, result);
        } finally { try { reset(); } catch (Exception ignored) { } }
    }
    private static void check(boolean condition, String name) { if (!condition) throw new AssertionError(name); }
    private SetupLink link(Fake fake) throws Exception { return new SetupLink(stage, config, delivery, fake, fake); }
    private SetupLink linked(Fake fake) throws Exception { SetupLink link = link(fake); link.begin(ORIGIN); check(link.check(), "link_confirmed"); return link; }
    private static JSONObject ring() throws Exception {
        return new JSONObject().put("address", "00:11:22:33:44:55").put("sn", "synthetic-ring-123456")
            .put("deviceId", "synthetic-device").put("bindKey", "synthetic-key");
    }
    private JSONObject complete(JSONObject binding) throws Exception {
        JSONObject value = VocciBindings.selected(binding);
        return value.put("origin", ORIGIN).put("ownerId", OWNER).put("credential", CREDENTIAL);
    }
    private void reset() throws Exception { stage.delete(); config.delete(); if (delivery.exists() && !delivery.delete()) throw new IOException("cleanup"); }
    private void rejects(String reason, Work work) throws Exception {
        try { work.run(); throw new AssertionError("guard_missing_" + reason); }
        catch (IllegalStateException expected) { check(reason.equals(expected.getMessage()), "expected_" + reason); passed++; }
    }
    private void prerequisites() throws Exception {
        Fake fake = new Fake(); SetupLink link = link(fake);
        rejects("setup_account_required", () -> link.selectBinding(ring()));
        rejects("setup_account_required", link::clearBinding);
        rejects("setup_account_required", link::verifyAndCommit);
        link.begin(ORIGIN); rejects("setup_account_required", () -> link.selectBinding(ring()));
        link.check(); rejects("setup_ring_required", link::verifyAndCommit);
        check(!config.exists() && fake.proofs == 0, "missing_prerequisites_never_prove_or_commit"); passed++;
    }
    private void selectionAndCommit() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake);
        JSONObject selected = ring().put("otherRingKey", "unselected-key").put("cookie", "not-a-moss-session");
        link.selectBinding(selected); selected.put("bindKey", "mutated-after-selection");
        JSONObject saved = stage.load().getJSONObject("binding");
        check(saved.length() == 4 && saved.getString("bindKey").equals("synthetic-key"), "selection_is_copied_and_projected");
        check(!stage.load().toString().contains("unselected-key"), "unselected_key_not_persisted");
        SetupLink restarted = link(fake);
        check(restarted.status().ringSelected && restarted.status().ringSuffix.equals("123456") && fake.proofs == 0, "restart_keeps_selection_without_proof");
        restarted.verifyAndCommit();
        check(fake.proofs == 1 && fake.owners == 2 && !stage.exists(), "commit_requires_fresh_ring_and_owner");
        JSONObject committed = config.load();
        check(committed.length() == 8 && committed.getString("bindKey").equals("synthetic-key") && committed.getString("ownerId").equals(OWNER), "complete_configuration_only");
        check(!delivery.exists() && !committed.has("enabled") && !committed.has("holdEnabled"), "commit_does_not_start_delivery_or_hold");
        SetupLink.Status status = restarted.status();
        check(status.phase == SetupLink.Phase.COMMITTED && status.origin.equals(ORIGIN) && status.accountName.equals("Synthetic ring owner") &&
            status.ringSelected && status.ringSuffix.equals("123456"), "committed_summary_survives_restart");
        rejects("setup_already_configured", () -> restarted.selectBinding(ring()));
        rejects("setup_already_configured", restarted::clearBinding);
        restarted.cancel(); check(config.exists() && fake.logouts == 0, "cancel_preserves_committed_config"); passed++;
    }
    private void malformedSelection() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake);
        String[] fields = {"address", "sn", "deviceId", "bindKey", "sn", "bindKey"};
        Object[] values = {"00-11-22-33-44-55", " padded", "bad\nid", 123, "", "x".repeat(257)};
        for (int i = 0; i < fields.length; i++) {
            JSONObject malformed = ring().put(fields[i], values[i]);
            try { link.selectBinding(malformed); throw new AssertionError("invalid_binding_accepted"); }
            catch (VocciHttp.Failure expected) { check(expected.code.equals("binding_response_invalid"), "invalid_binding_reason"); }
            check(!stage.load().has("binding") && !config.exists(), "invalid_binding_not_persisted"); passed++;
        }
        link.selectBinding(ring());
        link.selectBinding(ring().put("sn", "replacement-654321").put("bindKey", "replacement-key"));
        check(stage.load().getJSONObject("binding").getString("sn").equals("replacement-654321"), "uncommitted_selection_replaceable"); passed++;
    }
    private void proofRetry() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake); link.selectBinding(ring()); fake.failProof = true;
        try { link.verifyAndCommit(); throw new AssertionError("failed_proof_committed"); } catch (IOException expected) { }
        check(!config.exists() && stage.load().has("binding"), "failed_proof_keeps_retryable_selection");
        fake.failProof = false; link(fake).verifyAndCommit();
        check(fake.proofs == 2 && fake.owners == 2 && config.exists(), "retry_requires_fresh_physical_proof"); passed++;
    }
    private void ownerChecks() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake); link.selectBinding(ring());
        fake.duringProof = () -> fake.offlineOwner = true;
        try { link.verifyAndCommit(); throw new AssertionError("offline_owner_committed"); } catch (IOException expected) { }
        check(!config.exists() && stage.load().has("binding"), "owner_failure_does_not_commit"); passed++;
        fake.offlineOwner = false; fake.duringProof = () -> fake.revoked = true;
        try { link(fake).verifyAndCommit(); throw new AssertionError("revoked_owner_committed"); }
        catch (MossClient.Rejected expected) { check(expected.status == 401, "revoked_owner_rejected"); }
        check(!config.exists(), "revoked_credential_not_committed"); passed++;
        fake.revoked = false; fake.duringProof = () -> fake.owner = ATTEMPT;
        rejects("owner_mismatch", () -> link(fake).verifyAndCommit());
        check(!config.exists() && !stage.load().has("binding") && link(fake).status().phase == SetupLink.Phase.CLEANUP, "owner_mismatch_discards_candidate"); passed++;
    }
    private void interruptedCommit() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake); link.selectBinding(ring());
        // Disk state at the boundary after atomic config save, before staging deletion.
        config.save(complete(ring()));
        SetupLink restarted = link(fake); restarted.cancel();
        check(restarted.status().phase == SetupLink.Phase.COMMITTED && !stage.exists() && fake.logouts == 0, "adopted_selected_ring_preserves_credential"); passed++;
    }
    private void conflictingCommit() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake); link.selectBinding(ring());
        for (String field : new String[]{"address", "sn", "deviceId", "bindKey"}) {
            JSONObject different = complete(ring()).put(field, field.equals("address") ? "00:11:22:33:44:66" : "different-value");
            config.save(different);
            rejects("setup_recovery_required", () -> link(fake));
            check(stage.exists() && config.load().getString(field).equals(different.getString(field)) && fake.logouts == 0, "different_committed_ring_untouched");
        }
    }
    private void queueAppears() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake); link.selectBinding(ring());
        fake.duringProof = () -> PrivateFiles.json(delivery, new JSONObject().put("sourceDeviceId", OWNER));
        rejects("setup_recovery_required", link::verifyAndCommit);
        check(!config.exists() && PrivateFiles.json(delivery).getString("sourceDeviceId").equals(OWNER), "queue_rechecked_after_proof"); passed++;
    }
    private void offlineCancellation() throws Exception {
        Fake fake = new Fake(); SetupLink link = linked(fake); link.selectBinding(ring()); fake.offlineOwner = true;
        try { link.cancel(); throw new AssertionError("offline_cancel_expected"); } catch (IOException expected) { }
        check(!stage.load().has("binding") && stage.load().has("credential") && !config.exists(), "cancel_removes_ring_before_offline_cleanup");
        fake.offlineOwner = false; link(fake).cancel(); check(!stage.exists(), "cleanup_retry_completes"); passed++;
    }
    private void staleController() throws Exception {
        Fake fake = new Fake(); SetupLink first = linked(fake); SetupLink stale = link(fake);
        first.selectBinding(ring()); stale.verifyAndCommit();
        check(config.exists() && fake.proofs == 1 && first.status().phase == SetupLink.Phase.COMMITTED, "recreated_controller_reads_latest_selection"); passed++;
    }
    private void changeSelection() throws Exception {
        Fake fake = new Fake(); SetupLink first = linked(fake); SetupLink stale = link(fake);
        first.selectBinding(ring());
        stale.clearBinding();
        SetupLink restarted = link(fake);
        check(restarted.status().phase == SetupLink.Phase.LINKED && !restarted.status().ringSelected,
            "change_ring_keeps_confirmed_moss_link_after_restart");
        check(stage.load().getString("credential").equals(CREDENTIAL) && fake.logouts == 0 && fake.proofs == 0,
            "change_ring_needs_no_network_or_physical_proof");
        rejects("setup_ring_required", restarted::verifyAndCommit);
        restarted.selectBinding(ring().put("sn", "replacement-654321").put("bindKey", "replacement-key"));
        restarted.verifyAndCommit();
        check(config.load().getString("sn").equals("replacement-654321") && fake.proofs == 1,
            "replacement_requires_fresh_physical_verification"); passed++;
    }
}
