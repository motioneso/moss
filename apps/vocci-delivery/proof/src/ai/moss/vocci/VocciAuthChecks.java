package ai.moss.vocci;

import android.app.Instrumentation;
import android.os.Bundle;
import java.io.*;
import java.util.*;
import org.json.*;

/** Synthetic native-contract checks. They do not count as installed vendor acceptance. */
public final class VocciAuthChecks extends Instrumentation {
    private static final String EMAIL = "fixture@example.test";
    private static final String ROW = "{\"sn\":\"fixture-ring\",\"deviceId\":\"fixture-device\",\"macAddress\":\"001122334455\",\"bindKey\":\"synthetic-key\"}";
    private SecretStore secrets;
    private int passed;
    private boolean liveInitialization;
    private boolean diagnose;
    private static final class Fake implements VocciHttp.Transport {
        final ArrayDeque<String> expected = new ArrayDeque<>();
        final ArrayDeque<VocciHttp.Reply> replies = new ArrayDeque<>();
        boolean loseBody;
        int requests;
        Fake add(String method, String path, String json) {
            expected.add(method + " " + path); replies.add(new VocciHttp.Reply(200, null, "{\"response\":" + json + "}", 0)); return this;
        }
        Fake raw(String method, String path, int status, String json) {
            expected.add(method + " " + path); replies.add(new VocciHttp.Reply(status, null, json, 120)); return this;
        }
        @Override public VocciHttp.Reply request(String method, String url, String token, String form, VocciHttp.TokenSink rotation) throws Exception {
            VocciHttp.destination(method, url);
            String path = url.equals(VocciHttp.BINDINGS) ? "bindings" : url.substring(VocciHttp.CLERK.length(), url.indexOf('?'));
            check(!expected.isEmpty() && expected.remove().equals(method + " " + path), "request_contract");
            if (path.equals("bindings")) check(token.equals("Bearer aaa.bbb.ccc"), "binding_uses_session_token");
            else {
                check(path.equals("client") || token != null, "native_credential_required");
                rotation.save("synthetic-device-token-" + (++requests));
            }
            if (loseBody) { loseBody = false; throw new VocciHttp.Failure("auth_network_unavailable"); }
            if (path.endsWith("attempt_first_factor")) check(form.contains("strategy=email_code") && form.contains("code=123456"), "email_factor_contract");
            if (path.endsWith("attempt_second_factor")) check(form.contains("strategy=totp"), "totp_contract");
            return replies.remove();
        }
        void complete() { check(expected.isEmpty(), "all_requests_exercised"); }
    }
    @Override public void onCreate(Bundle args) {
        liveInitialization = args != null && "true".equals(args.getString("liveInitialization"));
        diagnose = args != null && "true".equals(args.getString("diagnose")); super.onCreate(args); start();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        if (diagnose) { diagnose(result); return; }
        if (liveInitialization) {
            try {
                boolean[] tokenReturned = {false};
                VocciHttp.Reply reply = VocciHttp.NETWORK.request("GET", VocciHttp.clerk("client"), null, "", token -> { tokenReturned[0] = true; });
                VocciHttp.success(reply);
                JSONObject client = new JSONObject(reply.body).getJSONObject("response");
                check(tokenReturned[0] && client.getJSONArray("sessions").length() == 0, "native_initialization_contract");
                result.putString("nativeInitialization", "PASS"); result.putInt("status", reply.status); result.putString("clientIdentity", VocciHttp.USER_AGENT); finish(-1, result);
            } catch (Exception failure) {
                result.putString("nativeInitialization", "FAIL");
                result.putString("reason", failure instanceof VocciHttp.Failure ? ((VocciHttp.Failure) failure).code : "native_initialization_failed"); finish(1, result);
            }
            return;
        }
        secrets = new SecretStore(getTargetContext(), "moss-vocci-auth-contract-test", "vocci-auth-contract-test.enc");
        try {
            secrets.delete(); emailAndBindings(); resumedLookup(); tokenShapeGuards(); requiredMfa(); invalidAndThrottled(); unsupportedMfa(); lostVerificationRecovery(); cleanupOffline(); malformedBindings(); transportGuards();
            result.putString("result", "PASS"); result.putInt("contracts", passed); finish(-1, result);
        } catch (Throwable failure) {
            result.putString("result", "FAIL"); result.putString("check", failure instanceof AssertionError ? failure.getMessage() : failure instanceof VocciHttp.Failure ? ((VocciHttp.Failure) failure).code : failure.getClass().getSimpleName()); finish(1, result);
        } finally { try { secrets.delete(); } catch (Exception ignored) { } }
    }
    private void diagnose(Bundle result) {
        try {
            SecretStore pending = new SecretStore(getTargetContext(), "moss-vocci-account-setup", "vocci-account.enc");
            check(pending.exists(), "pending_attempt_exists");
            JSONObject record = pending.load();
            for (String key : new String[]{"clientId", "signInId", "emailId", "sessionId", "verificationStarted", "deviceToken", "previousDeviceToken"}) result.putBoolean("has_" + key, record.has(key));
            VocciHttp.Reply reply = VocciHttp.NETWORK.request("GET", VocciHttp.clerk("client"), record.optString("deviceToken", null), "", token -> {
                if (record.has("deviceToken")) record.put("previousDeviceToken", record.getString("deviceToken"));
                record.put("deviceToken", token); pending.save(record);
            });
            result.putInt("httpStatus", reply.status);
            VocciHttp.success(reply);
            JSONObject client = new JSONObject(reply.body).getJSONObject("response");
            result.putBoolean("clientIdMatches", record.optString("clientId").equals(client.optString("id")));
            result.putInt("sessionCount", client.getJSONArray("sessions").length());
            JSONObject signIn = client.optJSONObject("sign_in");
            result.putBoolean("hasSignIn", signIn != null);
            if (signIn != null) {
                result.putBoolean("signInUsesSiaPrefix", signIn.optString("id").matches("sia_[A-Za-z0-9]+"));
                String status = signIn.optString("status");
                result.putString("signInStatus", Arrays.asList("needs_identifier", "needs_first_factor", "needs_second_factor", "complete", "needs_new_password").contains(status) ? status : "unsupported");
                JSONArray factors = signIn.optJSONArray("supported_first_factors");
                boolean emailCode = false;
                if (factors != null) for (int i = 0; i < factors.length(); i++) if (factors.getJSONObject(i).optString("strategy").equals("email_code")) emailCode = true;
                result.putBoolean("supportsEmailCode", emailCode);
            }
            // Restore the prior credential if the read returned a different client.
            if (!record.optString("clientId").equals(client.optString("id")) && record.has("previousDeviceToken")) {
                record.put("deviceToken", record.getString("previousDeviceToken")); pending.save(record);
            }
            result.putString("diagnostic", "PASS"); finish(-1, result);
        } catch (Exception failure) {
            result.putString("diagnostic", "FAIL"); result.putString("reason", failure instanceof VocciHttp.Failure ? ((VocciHttp.Failure) failure).code : "diagnostic_failed"); finish(1, result);
        }
    }
    private static void check(boolean value, String name) { if (!value) throw new AssertionError(name); }
    interface Work { void run() throws Exception; }
    private void rejects(String code, Work work) throws Exception {
        try { work.run(); throw new AssertionError("guard_missing_" + code); }
        catch (VocciHttp.Failure failure) { check(failure.code.equals(code), "expected_" + code); passed++; }
    }
    private static String client(String sessions) { return "{\"id\":\"client_test\",\"sessions\":" + sessions + "}"; }
    private static String signIn(String status, String tail) { return "{\"id\":\"sia_test\",\"status\":\"" + status + "\"" + tail + "}"; }
    private static Fake begin() {
        return new Fake().add("GET", "client", client("[]"))
            .add("POST", "client/sign_ins", signIn("needs_first_factor", ",\"supported_first_factors\":[{\"strategy\":\"email_code\",\"email_address_id\":\"idn_test\"}]"))
            .add("POST", "client/sign_ins/sia_test/prepare_first_factor", signIn("needs_first_factor", ""));
    }
    private static void cleanup(Fake fake) {
        fake.add("GET", "client", client("[{\"id\":\"sess_test\",\"status\":\"active\"}]"))
            .add("POST", "client/sessions/sess_test/remove", "{\"id\":\"sess_test\",\"status\":\"removed\"}")
            .add("GET", "client", client("[]"));
    }
    private void emailAndBindings() throws Exception {
        Fake fake = begin().add("POST", "client/sign_ins/sia_test/attempt_first_factor", signIn("complete", ",\"created_session_id\":\"sess_test\""))
            .raw("POST", "client/sessions/sess_test/tokens", 200, "{\"object\":\"token\",\"jwt\":\"aaa.bbb.ccc\"}")
            .raw("GET", "bindings", 200, "[" + ROW + "]"); cleanup(fake);
        VocciAccount account = new VocciAccount(secrets, fake); account.begin(EMAIL);
        check(account.step() == VocciAccount.Step.CODE, "email_code_sent");
        account.verify("123456"); check(account.bindings().size() == 1, "one_owned_ring");
        account.cleanup(); check(!secrets.exists(), "cleanup_record_deleted_after_confirmation"); fake.complete(); passed++;
    }
    private void savedVerifiedSession() throws Exception {
        secrets.save(new JSONObject().put("deviceToken", "synthetic-device-token").put("clientId", "client_test")
            .put("isolatedClient", true).put("verificationStarted", true).put("sessionId", "sess_test"));
    }
    private void resumedLookup() throws Exception {
        savedVerifiedSession();
        Fake fake = new Fake().add("GET", "client", client("[{\"id\":\"sess_test\",\"status\":\"active\"}]"))
            .raw("POST", "client/sessions/sess_test/tokens", 200, "{\"object\":\"token\",\"jwt\":\"aaa.bbb.ccc\"}")
            .raw("GET", "bindings", 200, "[" + ROW + "]"); cleanup(fake);
        VocciAccount account = new VocciAccount(secrets, fake);
        check(account.canResumeLookup(), "verified_session_can_resume"); account.resumeLookup();
        check(account.bindings().size() == 1, "resumed_backend_lookup"); account.cleanup(); fake.complete(); passed++;
        savedVerifiedSession();
        Fake wrong = new Fake().add("GET", "client", client("[{\"id\":\"sess_other\",\"status\":\"active\"}]"));
        rejects("auth_cleanup_conflict", () -> new VocciAccount(secrets, wrong).resumeLookup()); wrong.complete();
        Fake changed = new Fake().add("GET", "client", client("[{\"id\":\"sess_test\",\"status\":\"active\"}]").replace("client_test", "client_other"));
        rejects("auth_client_changed", () -> new VocciAccount(secrets, changed).resumeLookup()); changed.complete();
        Fake expired = new Fake().add("GET", "client", client("[{\"id\":\"sess_test\",\"status\":\"expired\"}]"));
        rejects("auth_session_expired", () -> new VocciAccount(secrets, expired).resumeLookup()); expired.complete();
        Fake multiple = new Fake().add("GET", "client", client("[{\"id\":\"sess_test\",\"status\":\"active\"},{\"id\":\"sess_other\",\"status\":\"active\"}]"));
        rejects("auth_cleanup_conflict", () -> new VocciAccount(secrets, multiple).resumeLookup()); multiple.complete();
        JSONObject incomplete = secrets.load(); incomplete.remove("verificationStarted"); secrets.save(incomplete);
        Fake unused = new Fake();
        VocciAccount notVerified = new VocciAccount(secrets, unused);
        check(!notVerified.canResumeLookup(), "unverified_session_cannot_resume");
        rejects("auth_step_invalid", () -> notVerified.resumeLookup()); unused.complete(); secrets.delete();
    }
    private void tokenShapeGuards() throws Exception {
        for (String body : new String[]{"{\"jwt\":\"aaa.bbb.ccc\"}", "{\"object\":\"client\",\"jwt\":\"aaa.bbb.ccc\"}", "{\"object\":\"token\",\"jwt\":123}", "{\"response\":{\"jwt\":\"aaa.bbb.ccc\"}}"}) {
            savedVerifiedSession();
            Fake fake = new Fake().add("GET", "client", client("[{\"id\":\"sess_test\",\"status\":\"active\"}]"))
                .raw("POST", "client/sessions/sess_test/tokens", 200, body);
            VocciAccount account = new VocciAccount(secrets, fake); account.resumeLookup();
            rejects("auth_response_invalid", () -> account.bindings()); fake.complete(); secrets.delete();
        }
    }
    private void requiredMfa() throws Exception {
        Fake fake = begin().add("POST", "client/sign_ins/sia_test/attempt_first_factor", signIn("needs_second_factor", ",\"supported_second_factors\":[{\"strategy\":\"totp\"}]"))
            .add("POST", "client/sign_ins/sia_test/attempt_second_factor", signIn("complete", ",\"created_session_id\":\"sess_test\""));
        VocciAccount account = new VocciAccount(secrets, fake); account.begin(EMAIL); account.verify("123456");
        check(account.step() == VocciAccount.Step.TOTP, "mfa_required");
        rejects("auth_step_invalid", () -> account.bindings());
        account.verify("654321"); check(account.step() == VocciAccount.Step.CONNECTED, "totp_completed"); fake.complete(); secrets.delete(); passed++;
    }
    private void invalidAndThrottled() throws Exception {
        Fake fake = begin().raw("POST", "client/sign_ins/sia_test/attempt_first_factor", 422, "{\"errors\":[{\"code\":\"form_code_incorrect\",\"message\":\"private-server-message\"}]}");
        VocciAccount account = new VocciAccount(secrets, fake); account.begin(EMAIL);
        rejects("auth_resend_wait", () -> account.resend());
        rejects("auth_code_invalid", () -> account.verify("secret-code"));
        rejects("auth_code_incorrect", () -> account.verify("123456"));
        check(account.step() == VocciAccount.Step.CODE, "wrong_code_keeps_attempt"); fake.complete(); secrets.delete();
        rejects("auth_rate_limited", () -> VocciHttp.success(new VocciHttp.Reply(429, null, "private-server-message", 120)));
        rejects("auth_account_not_found", () -> VocciHttp.success(new VocciHttp.Reply(422, null, "{\"errors\":[{\"code\":\"form_identifier_not_found\"}]}", 0)));
        rejects("auth_code_expired", () -> VocciHttp.success(new VocciHttp.Reply(422, null, "{\"errors\":[{\"code\":\"verification_expired\"}]}", 0)));
    }
    private void unsupportedMfa() throws Exception {
        Fake fake = begin().add("POST", "client/sign_ins/sia_test/attempt_first_factor", signIn("needs_second_factor", ",\"supported_second_factors\":[{\"strategy\":\"phone_code\"}]"));
        VocciAccount account = new VocciAccount(secrets, fake); account.begin(EMAIL);
        rejects("auth_method_unsupported", () -> account.verify("123456"));
        check(account.step() == VocciAccount.Step.CLEANUP && secrets.exists(), "unsupported_mfa_preserves_cleanup"); fake.complete(); secrets.delete();
    }
    private void lostVerificationRecovery() throws Exception {
        Fake fake = begin().add("POST", "client/sign_ins/sia_test/attempt_first_factor", "{}");
        VocciAccount account = new VocciAccount(secrets, fake); account.begin(EMAIL); fake.loseBody = true;
        rejects("auth_network_unavailable", () -> account.verify("123456"));
        check(secrets.load().has("deviceToken") && secrets.load().optBoolean("verificationStarted"), "lost_response_keeps_cleanup_material");
        check(secrets.load().getString("deviceToken").equals("synthetic-device-token-4"), "rotated_token_persisted_before_lost_body");
        Fake recovery = new Fake(); cleanup(recovery);
        VocciAccount restarted = new VocciAccount(secrets, recovery);
        check(restarted.step() == VocciAccount.Step.CLEANUP, "restart_does_not_send_code");
        rejects("auth_cleanup_required", () -> restarted.begin(EMAIL)); restarted.cleanup(); recovery.complete(); passed++;
    }
    private void cleanupOffline() throws Exception {
        secrets.save(new JSONObject().put("deviceToken", "synthetic-device-token").put("clientId", "client_test").put("isolatedClient", true).put("verificationStarted", true).put("sessionId", "sess_test"));
        VocciAccount offline = new VocciAccount(secrets, (m, u, a, f, r) -> { throw new VocciHttp.Failure("auth_network_unavailable"); });
        rejects("auth_network_unavailable", () -> offline.cleanup()); check(secrets.exists(), "offline_cleanup_retained");
        Fake conflict = new Fake().add("GET", "client", client("[{\"id\":\"sess_different\",\"status\":\"active\"}]"));
        rejects("auth_cleanup_conflict", () -> new VocciAccount(secrets, conflict).cleanup()); conflict.complete();
        Fake changed = new Fake().add("GET", "client", client("[]").replace("client_test", "client_different")).add("GET", "client", client("[]"));
        rejects("auth_client_changed", () -> new VocciAccount(secrets, changed).cleanup());
        check(changed.expected.size() == 1, "changed_client_stops_before_confirmation");
        check(secrets.exists(), "changed_client_does_not_confirm_revocation");
        Fake recovered = new Fake().add("GET", "client", client("[]")).add("GET", "client", client("[]"));
        new VocciAccount(secrets, recovered).cleanup(); recovered.complete(); passed++;
    }
    private void malformedBindings() throws Exception {
        check(VocciBindings.parse("[]").isEmpty(), "empty_inventory");
        check(VocciBindings.parse("{\"success\":true,\"code\":0,\"data\":[" + ROW + "]}").size() == 1, "successful_envelope");
        rejects("binding_lookup_rejected", () -> VocciBindings.parse("{\"success\":false,\"code\":0,\"data\":[]}"));
        rejects("binding_identity_ambiguous", () -> VocciBindings.parse("[" + ROW + "," + ROW + "]"));
        rejects("binding_response_invalid", () -> VocciBindings.parse("[" + ROW.replace("synthetic-key", "") + "]"));
        rejects("binding_response_invalid", () -> VocciBindings.parse("[" + ROW.replace("001122334455", "xx001122334455xx") + "]"));
        rejects("binding_response_invalid", () -> VocciBindings.parse("[" + ROW.replace("\"fixture-device\"", "123") + "]"));
    }
    private void transportGuards() throws Exception {
        rejects("auth_redirect_rejected", () -> VocciHttp.success(new VocciHttp.Reply(302, null, "", 0)));
        rejects("auth_service_rejected", () -> VocciHttp.success(new VocciHttp.Reply(403, null, "private-server-message", 0)));
        rejects("invalid_auth_destination", () -> VocciHttp.destination("GET", "https://example.test/"));
        rejects("invalid_auth_path", () -> VocciHttp.clerk("client/sessions/sess_test/../../me"));
        rejects("invalid_auth_token", () -> VocciHttp.header("token\r\nCookie: secret"));
        rejects("auth_response_too_large", () -> VocciHttp.read(new ByteArrayInputStream(new byte[VocciHttp.MAX_BYTES + 1])));
        check(VocciHttp.read(new ByteArrayInputStream(new byte[VocciHttp.MAX_BYTES])).length == VocciHttp.MAX_BYTES, "bounded_response_accepted"); passed++;
    }
}
