package ai.moss.vocci;

import android.content.Context;
import java.util.*;
import org.json.*;

/** Serialized setup-only native sign-in. Call on a worker; UI receives no account tokens. */
final class VocciAccount {
    enum Step { EMAIL, CODE, TOTP, CONNECTED, CLEANUP }
    private final SecretStore secrets;
    private final VocciHttp.Transport transport;
    private JSONObject record;
    private Step step;
    VocciAccount(Context context) throws Exception {
        this(new SecretStore(context, "moss-vocci-account-setup", "vocci-account.enc"), VocciHttp.NETWORK);
    }
    VocciAccount(SecretStore secrets, VocciHttp.Transport transport) throws Exception {
        this.secrets = secrets; this.transport = transport;
        record = secrets.exists() ? secrets.load() : new JSONObject();
        step = secrets.exists() ? Step.CLEANUP : Step.EMAIL;
    }
    Step step() { return step; }
    long resendAfter() { return record.optLong("resendAfter", 0); }
    private void save() throws Exception { secrets.save(record); }
    private JSONObject clerk(String method, String path, String form) throws Exception {
        VocciHttp.Reply reply = transport.request(method, VocciHttp.clerk(path), record.optString("deviceToken", null), form,
            token -> {
                if (record.has("deviceToken") && !record.getString("deviceToken").equals(token)) record.put("previousDeviceToken", record.getString("deviceToken"));
                record.put("deviceToken", VocciHttp.header(token)); save();
            });
        if (reply.status == 429) {
            record.put("resendAfter", System.currentTimeMillis() + Math.max(60, reply.retrySeconds) * 1000L); save();
        }
        VocciHttp.success(reply);
        try {
            JSONObject body = new JSONObject(reply.body), response = body.getJSONObject("response");
            JSONObject client = path.equals("client") ? response : body.optJSONObject("client");
            if (record.has("clientId") && client != null && !record.getString("clientId").equals(client.optString("id"))) {
                if (record.has("previousDeviceToken")) record.put("deviceToken", record.getString("previousDeviceToken"));
                save(); throw new VocciHttp.Failure("auth_client_changed");
            }
            record.remove("previousDeviceToken"); save();
            return response;
        }
        catch (VocciHttp.Failure known) { throw known; }
        catch (Exception malformed) { throw new VocciHttp.Failure("auth_response_invalid"); }
    }
    void begin(String email) throws Exception {
        if (step != Step.EMAIL || secrets.exists()) throw new VocciHttp.Failure("auth_cleanup_required");
        if (email.length() > 254 || !email.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) throw new VocciHttp.Failure("auth_email_invalid");
        // Save before any request so interrupted work is shown as recovery, never auto-resend.
        record = new JSONObject(); save(); step = Step.CLEANUP;
        JSONObject client = clerk("GET", "client", "");
        if (client.getJSONArray("sessions").length() != 0 || !record.has("deviceToken")) throw new VocciHttp.Failure("auth_client_not_empty");
        record.put("clientId", id(client.getString("id"), "client_")).put("isolatedClient", true); save();
        JSONObject signIn = clerk("POST", "client/sign_ins", VocciHttp.form("identifier", email));
        record.put("signInId", id(signIn.getString("id"), "sia_")); save();
        if (!signIn.optString("status").equals("needs_first_factor")) throw new VocciHttp.Failure("auth_method_unsupported");
        JSONArray factors = signIn.getJSONArray("supported_first_factors");
        String emailId = null;
        for (int i = 0; i < factors.length(); i++) {
            JSONObject factor = factors.getJSONObject(i);
            if (factor.optString("strategy").equals("email_code")) {
                if (emailId != null) throw new VocciHttp.Failure("auth_method_unsupported");
                emailId = id(factor.getString("email_address_id"), "idn_");
            }
        }
        if (emailId == null) throw new VocciHttp.Failure("auth_method_unsupported");
        record.put("emailId", emailId); save(); step = Step.CODE;
        resend();
    }
    void resend() throws Exception {
        if (step != Step.CODE) throw new VocciHttp.Failure("auth_step_invalid");
        if (System.currentTimeMillis() < resendAfter()) throw new VocciHttp.Failure("auth_resend_wait");
        record.put("resendAfter", System.currentTimeMillis() + 60000); save();
        clerk("POST", "client/sign_ins/" + record.getString("signInId") + "/prepare_first_factor",
            VocciHttp.form("strategy", "email_code", "email_address_id", record.getString("emailId")));
    }
    void verify(String code) throws Exception {
        if (step != Step.CODE && step != Step.TOTP) throw new VocciHttp.Failure("auth_step_invalid");
        if (!code.matches("[0-9]{6}")) throw new VocciHttp.Failure("auth_code_invalid");
        record.put("verificationStarted", true); save();
        boolean second = step == Step.TOTP;
        JSONObject signIn;
        try {
            signIn = clerk("POST", "client/sign_ins/" + record.getString("signInId") +
                (second ? "/attempt_second_factor" : "/attempt_first_factor"), VocciHttp.form("strategy", second ? "totp" : "email_code", "code", code));
        } catch (VocciHttp.Failure failed) {
            if (!Arrays.asList("auth_code_incorrect", "auth_code_expired", "auth_rate_limited").contains(failed.code)) step = Step.CLEANUP;
            throw failed;
        }
        if (!record.getString("signInId").equals(signIn.getString("id"))) throw new VocciHttp.Failure("auth_response_invalid");
        String status = signIn.getString("status");
        if (status.equals("complete")) {
            record.put("sessionId", id(signIn.getString("created_session_id"), "sess_")); save(); step = Step.CONNECTED; return;
        }
        if (!second && status.equals("needs_second_factor")) {
            JSONArray factors = signIn.getJSONArray("supported_second_factors");
            for (int i = 0; i < factors.length(); i++) {
                if (factors.getJSONObject(i).optString("strategy").equals("totp")) { step = Step.TOTP; return; }
            }
        }
        step = Step.CLEANUP; throw new VocciHttp.Failure("auth_method_unsupported");
    }
    List<JSONObject> bindings() throws Exception {
        if (step != Step.CONNECTED) throw new VocciHttp.Failure("auth_step_invalid");
        JSONObject token = clerk("POST", "client/sessions/" + record.getString("sessionId") + "/tokens", VocciHttp.form("organization_id", ""));
        String jwt = VocciHttp.header(token.getString("jwt"));
        if (!jwt.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")) throw new VocciHttp.Failure("auth_response_invalid");
        VocciHttp.Reply reply = transport.request("GET", VocciHttp.BINDINGS, "Bearer " + jwt, "", ignored -> { });
        VocciHttp.success(reply);
        try { return VocciBindings.parse(reply.body); }
        catch (VocciHttp.Failure known) { throw known; }
        catch (Exception malformed) { throw new VocciHttp.Failure("binding_response_invalid"); }
    }
    void cleanup() throws Exception {
        if (!secrets.exists()) { step = Step.EMAIL; return; }
        step = Step.CLEANUP;
        if (!record.has("deviceToken")) {
            if (record.optBoolean("verificationStarted")) throw new VocciHttp.Failure("auth_cleanup_required");
            secrets.delete(); record = new JSONObject(); step = Step.EMAIL; return;
        }
        JSONObject client = clerk("GET", "client", "");
        JSONArray sessions = client.getJSONArray("sessions");
        // This client was initialized empty and is never shared with another app/browser.
        if (sessions.length() > 1 || sessions.length() > 0 && !record.optBoolean("isolatedClient")) throw new VocciHttp.Failure("auth_cleanup_conflict");
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.getJSONObject(i);
            String sessionId = id(session.getString("id"), "sess_");
            if (record.has("sessionId") && !record.getString("sessionId").equals(sessionId) || !record.optBoolean("verificationStarted"))
                throw new VocciHttp.Failure("auth_cleanup_conflict");
            if (!ended(session.optString("status"))) {
                JSONObject removed = clerk("POST", "client/sessions/" + sessionId + "/remove", "");
                if (!sessionId.equals(removed.optString("id")) || !ended(removed.optString("status"))) throw new VocciHttp.Failure("auth_cleanup_unconfirmed");
            }
        }
        // A lost remove response is resolved by reading this same isolated client on retry.
        JSONArray remaining = clerk("GET", "client", "").getJSONArray("sessions");
        for (int i = 0; i < remaining.length(); i++)
            if (!ended(remaining.getJSONObject(i).optString("status"))) throw new VocciHttp.Failure("auth_cleanup_unconfirmed");
        secrets.delete(); record = new JSONObject(); step = Step.EMAIL;
    }
    private static boolean ended(String status) {
        return status.equals("ended") || status.equals("removed") || status.equals("revoked") || status.equals("expired") || status.equals("abandoned");
    }
    private static String id(String value, String prefix) throws VocciHttp.Failure {
        if (!value.matches(prefix + "[A-Za-z0-9]{1,128}")) throw new VocciHttp.Failure("auth_response_invalid");
        return value;
    }
}
