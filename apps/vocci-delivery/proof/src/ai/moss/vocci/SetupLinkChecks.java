package ai.moss.vocci;

import android.app.Instrumentation;
import android.os.Bundle;
import java.io.File;
import java.io.IOException;
import java.time.Instant;
import org.json.JSONObject;

/** Synthetic staging contracts; uses dedicated stores, never the installed companion. */
public final class SetupLinkChecks extends Instrumentation {
    private static final String ORIGIN = "https://moss.example.test";
    private static final String OWNER = "00000000-0000-4000-8000-000000000001";
    private static final String CREDENTIAL = "vr1_" + "A".repeat(43);
    private static final String ATTEMPT = "00000000-0000-4000-8000-000000000002";
    private SecretStore stage, config;
    private File delivery;
    private int passed;
    private boolean inspect;
    private static final class Fake implements SetupLink.Port {
        boolean approved, active, offline, loseRedeem, ownerOffline, cancelOffline, loseCreate, malformedAccount, loseLogout;
        String owner = OWNER;
        int creates, redeems, cancels, logouts;
        @Override public JSONObject request(String origin, String path, JSONObject body) throws Exception {
            check(origin.equals(ORIGIN), "origin_pinned");
            if (offline) throw new IOException("offline");
            if (path.equals("/api/companion/pair")) {
                creates++;
                check(body.getString("platform").equals("android") && !body.has("verifier") && body.getString("verifierHash").matches("[A-Za-z0-9_-]{43}"), "public_request_contains_hash_only");
                if (loseCreate) throw new IOException("lost_create_response");
                return new JSONObject().put("attemptId", ATTEMPT).put("approvalPath", "/link/trail-marker#code=" + "b".repeat(32))
                    .put("expiresAt", Instant.now().plusSeconds(600).toString());
            }
            check(body.getString("attemptId").equals(ATTEMPT) && body.getString("verifier").matches("[A-Za-z0-9_-]{43}"), "attempt_proof");
            if (path.equals("/api/companion/pair/redeem")) {
                redeems++;
                if (!approved) return new JSONObject().put("status", "pending");
                active = true;
                if (loseRedeem) throw new IOException("lost_response");
                return new JSONObject().put("credential", CREDENTIAL).put("expiresAt", Instant.now().plusSeconds(86400).toString())
                    .put("account", new JSONObject().put("id", malformedAccount ? "malformed" : OWNER).put("name", "Synthetic owner"));
            }
            check(path.equals("/api/companion/pair/cancel"), "only_pairing_routes");
            if (cancelOffline) throw new IOException("cancel_offline");
            cancels++; active = false; return new JSONObject();
        }
        @Override public String owner(JSONObject value) throws Exception {
            check(value.getString("credential").equals(CREDENTIAL) && value.getString("origin").equals(ORIGIN), "owner_uses_staged_credential");
            if (ownerOffline) throw new IOException("owner_offline");
            check(active, "credential_active"); return owner;
        }
        @Override public void logout(JSONObject value) throws Exception {
            check(value.getString("credential").equals(CREDENTIAL) && value.getString("origin").equals(ORIGIN), "logout_uses_staged_credential");
            if (offline) throw new IOException("offline");
            logouts++; active = false;
            if (loseLogout) throw new IOException("lost_logout_response");
        }
    }
    @Override public void onCreate(Bundle args) { super.onCreate(args); inspect = "true".equals(args.getString("inspect")); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        if (inspect) {
            try {
                SetupLink link = new SetupLink(getTargetContext()); SetupLink.Status status = link.status();
                result.putString("phase", status.phase.name());
                result.putBoolean("hasConfiguration", new SecretStore(getTargetContext()).exists());
                result.putBoolean("hasStaging", new SecretStore(getTargetContext(), "moss-vocci-setup", "setup.enc").exists());
                // The existing browser URL only, never the verifier or device credential.
                // The private live UI harness consumes this without logging its value.
                if (status.phase == SetupLink.Phase.APPROVAL) result.putString("approvalUrl", link.begin(status.origin));
                finish(-1, result);
            } catch (Exception error) { result.putString("result", "FAIL"); finish(1, result); }
            return;
        }
        stage = new SecretStore(getTargetContext(), "setup-link-contract-stage", "setup-link-contract-stage.enc");
        config = new SecretStore(getTargetContext(), "setup-link-contract-config", "setup-link-contract-config.enc");
        delivery = new File(getTargetContext().getNoBackupFilesDir(), "setup-link-contract-delivery.json");
        try {
            reset(); freshAndConfirmed(); reset(); ownerConfirmationRecovery(); reset(); lostRedemption(); reset();
            offlineCancel(); reset(); expiredAttempt(); reset(); ownerMismatch(); reset(); committedRecovery(); reset(); orphanQueue();
            reset(); lostCreate(); reset(); incompleteCleanup(); reset(); malformedAccount();
            reset(); corruptConfiguration(); reset(); lostLogout(); reset(); staleController();
            result.putString("result", "PASS"); result.putInt("contracts", passed); finish(-1, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL"); result.putString("check", error instanceof AssertionError ? error.getMessage() : error.getClass().getSimpleName()); finish(1, result);
        } finally { try { reset(); } catch (Exception ignored) { } }
    }
    private SetupLink link(Fake fake) throws Exception { return new SetupLink(stage, config, delivery, fake, binding -> { throw new AssertionError("unexpected_ring_proof"); }); }
    private void reset() throws Exception { stage.delete(); config.delete(); if (delivery.exists() && !delivery.delete()) throw new IOException("cleanup"); }
    private static void check(boolean condition, String name) { if (!condition) throw new AssertionError(name); }
    interface Work { void run() throws Exception; }
    private void rejects(String reason, Work work) throws Exception {
        try { work.run(); throw new AssertionError("guard_missing_" + reason); }
        catch (IllegalStateException error) { check(reason.equals(error.getMessage()), "expected_" + reason); passed++; }
    }
    private void freshAndConfirmed() throws Exception {
        Fake fake = new Fake(); SetupLink link = link(fake);
        check(link.status().phase == SetupLink.Phase.EMPTY, "fresh_is_empty");
        String url = link.begin(ORIGIN); check(url.startsWith(ORIGIN + "/link/trail-marker#code="), "approval_stays_on_origin");
        check(!config.exists() && link.status().phase == SetupLink.Phase.APPROVAL, "pending_is_not_delivery_config");
        check(link.begin(ORIGIN).equals(url) && fake.creates == 1, "reopen_does_not_create_attempt");
        rejects("setup_origin_pinned", () -> link.begin("https://other.example.test"));
        check(!link.check(), "approval_pending");
        fake.approved = true; check(link.check(), "approval_confirmed");
        check(link.status().phase == SetupLink.Phase.LINKED && !config.exists(), "linked_still_staged");
        link.cancel(); check(fake.logouts == 1 && fake.cancels == 1 && !fake.active && !stage.exists(), "known_credential_revoked"); passed++;
    }
    private void ownerConfirmationRecovery() throws Exception {
        Fake fake = new Fake(); fake.approved = true; fake.ownerOffline = true;
        SetupLink link = link(fake); link.begin(ORIGIN);
        try { link.check(); throw new AssertionError("offline_owner_expected"); } catch (IOException expected) { }
        check(stage.load().getString("credential").equals(CREDENTIAL) && !config.exists(), "credential_saved_before_owner_read");
        fake.ownerOffline = false; SetupLink restarted = link(fake);
        check(restarted.status().phase == SetupLink.Phase.CONFIRMING && restarted.check() && fake.redeems == 1, "restart_does_not_redeem_twice");
        restarted.cancel(); passed++;
    }
    private void lostRedemption() throws Exception {
        Fake fake = new Fake(); fake.approved = true; fake.loseRedeem = true;
        SetupLink link = link(fake); link.begin(ORIGIN);
        try { link.check(); throw new AssertionError("lost_redeem_expected"); } catch (IOException expected) { }
        SetupLink restarted = link(fake);
        check(restarted.status().phase == SetupLink.Phase.CLEANUP && fake.active, "lost_response_requires_cleanup");
        rejects("setup_cleanup_required", () -> restarted.check());
        restarted.cancel(); check(!fake.active && fake.logouts == 0 && fake.cancels == 1 && !stage.exists(), "lost_response_cancels_with_proof"); passed++;
    }
    private void offlineCancel() throws Exception {
        Fake fake = new Fake(); fake.approved = true;
        SetupLink link = link(fake); link.begin(ORIGIN); link.check(); fake.offline = true;
        try { link.cancel(); throw new AssertionError("offline_cleanup_expected"); } catch (IOException expected) { }
        check(stage.exists() && fake.active, "offline_cleanup_material_retained");
        SetupLink restarted = link(fake); check(restarted.status().phase == SetupLink.Phase.CLEANUP, "cleanup_survives_restart");
        rejects("setup_cleanup_required", () -> restarted.check());
        fake.offline = false; restarted.cancel(); check(!fake.active && !stage.exists(), "cleanup_retry_confirmed"); passed++;
    }
    private void expiredAttempt() throws Exception {
        Fake fake = new Fake(); SetupLink link = link(fake); link.begin(ORIGIN);
        JSONObject saved = stage.load(); saved.put("expiresAt", Instant.now().minusSeconds(1).toString()); stage.save(saved);
        SetupLink restarted = link(fake);
        rejects("link_expired", () -> restarted.check()); check(fake.redeems == 0, "expired_attempt_not_redeemed");
        restarted.cancel(); check(!stage.exists(), "expired_attempt_can_cancel"); passed++;
    }
    private void ownerMismatch() throws Exception {
        Fake fake = new Fake(); fake.approved = true; fake.owner = ATTEMPT;
        SetupLink link = link(fake); link.begin(ORIGIN);
        rejects("owner_mismatch", () -> link.check());
        check(link.status().phase == SetupLink.Phase.CLEANUP && !config.exists(), "owner_mismatch_blocks_setup"); link.cancel(); passed++;
    }
    private void committedRecovery() throws Exception {
        Fake fake = new Fake(); fake.approved = true;
        SetupLink link = link(fake); link.begin(ORIGIN); link.check();
        JSONObject active = new JSONObject().put("origin", ORIGIN).put("ownerId", OWNER).put("credential", CREDENTIAL)
            .put("address", "00:11:22:33:44:55").put("sn", "synthetic-ring").put("deviceId", "synthetic-device").put("bindKey", "synthetic-key");
        config.save(active);
        SetupLink restarted = link(fake); restarted.cancel();
        check(restarted.status().phase == SetupLink.Phase.COMMITTED && !stage.exists(), "committed_staging_reconciled");
        check(fake.active && fake.logouts == 0 && fake.cancels == 0, "committed_credential_preserved"); passed++;
        config.delete(); link = link(fake); link.begin(ORIGIN); link.check();
        active.put("ownerId", ATTEMPT); config.save(active);
        rejects("setup_recovery_required", () -> link(fake));
        check(stage.exists() && fake.active && config.load().getString("ownerId").equals(ATTEMPT), "unrelated_configuration_untouched");
    }
    private void orphanQueue() throws Exception {
        Fake fake = new Fake(); PrivateFiles.json(delivery, new JSONObject().put("sourceDeviceId", OWNER));
        SetupLink link = link(fake); check(link.status().phase == SetupLink.Phase.RECOVERY, "orphan_queue_requires_recovery");
        rejects("setup_recovery_required", () -> link.begin(ORIGIN)); check(fake.creates == 0, "orphan_queue_does_not_link"); passed++;
    }
    private void lostCreate() throws Exception {
        Fake fake = new Fake(); fake.loseCreate = true; SetupLink link = link(fake);
        try { link.begin(ORIGIN); throw new AssertionError("lost_create_expected"); } catch (IOException expected) { }
        SetupLink restarted = link(fake);
        check(restarted.status().phase == SetupLink.Phase.CLEANUP && !config.exists(), "lost_create_saved_before_request");
        restarted.cancel(); check(fake.cancels == 0 && !stage.exists(), "unapproved_lost_create_needs_no_credential_revocation"); passed++;
    }
    private void incompleteCleanup() throws Exception {
        Fake fake = new Fake(); fake.approved = true; SetupLink link = link(fake); link.begin(ORIGIN); link.check();
        fake.cancelOffline = true;
        try { link.cancel(); throw new AssertionError("cancel_offline_expected"); } catch (IOException expected) { }
        check(stage.exists() && !fake.active && !stage.load().has("credential"), "successful_logout_keeps_only_proof_for_cleanup");
        fake.cancelOffline = false; link(fake).cancel();
        check(fake.logouts == 1 && fake.cancels == 1 && !stage.exists(), "cleanup_after_logout_does_not_repeat_logout"); passed++;
    }
    private void malformedAccount() throws Exception {
        Fake fake = new Fake(); fake.approved = true; fake.malformedAccount = true;
        SetupLink link = link(fake); link.begin(ORIGIN);
        try { link.check(); throw new AssertionError("invalid_account_expected"); } catch (IllegalArgumentException expected) { }
        check(link(fake).status().phase == SetupLink.Phase.CLEANUP && stage.load().getString("credential").equals(CREDENTIAL), "bad_account_retains_revocable_credential");
        link(fake).cancel(); check(!fake.active && !stage.exists(), "bad_account_credential_revoked"); passed++;
    }
    private void corruptConfiguration() throws Exception {
        Fake fake = new Fake(); fake.approved = true;
        SetupLink link = link(fake); link.begin(ORIGIN); link.check();
        JSONObject active = new JSONObject().put("origin", ORIGIN).put("ownerId", OWNER).put("credential", CREDENTIAL)
            .put("address", "00:11:22:33:44:55").put("sn", "synthetic-ring").put("deviceId", "synthetic-device").put("bindKey", "synthetic-key");
        String[] fields = {"sn", "deviceId", "bindKey", "address", "ownerId", "credential"};
        Object[] values = {123, " padded", "bad\nkey", "00-11-22-33-44-55", "malformed", "invalid"};
        for (int i = 0; i < fields.length; i++) {
            JSONObject corrupt = new JSONObject(active.toString()).put(fields[i], values[i]); config.save(corrupt);
            rejects("setup_recovery_required", () -> link(fake));
            check(stage.exists() && fake.active && fake.logouts == 0 && fake.cancels == 0, "corrupt_configuration_keeps_recovery_material");
            check(config.load().toString().equals(corrupt.toString()), "corrupt_configuration_untouched");
        }
        config.delete(); link(fake).cancel(); passed++;
    }
    private void lostLogout() throws Exception {
        Fake fake = new Fake(); fake.approved = true;
        SetupLink link = link(fake); link.begin(ORIGIN); link.check(); fake.loseLogout = true;
        try { link.cancel(); throw new AssertionError("lost_logout_expected"); } catch (IOException expected) { }
        check(stage.exists() && !fake.active && stage.load().has("credential"), "lost_logout_retains_retry_material");
        fake.loseLogout = false; link(fake).cancel();
        check(fake.logouts == 2 && fake.cancels == 1 && !stage.exists(), "idempotent_logout_retry_finishes_cleanup"); passed++;
    }
    private void staleController() throws Exception {
        Fake fake = new Fake(); fake.approved = true;
        SetupLink first = link(fake); first.begin(ORIGIN); SetupLink recreated = link(fake);
        first.check();
        check(recreated.status().phase == SetupLink.Phase.LINKED, "recreated_controller_reads_latest_staging");
        check(recreated.check() && fake.redeems == 1, "recreated_controller_does_not_redeem_twice");
        recreated.cancel();
        check(first.status().phase == SetupLink.Phase.EMPTY && !fake.active, "old_controller_observes_confirmed_cleanup"); passed++;
    }
}
