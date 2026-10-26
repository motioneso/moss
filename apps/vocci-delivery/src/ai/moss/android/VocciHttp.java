package ai.moss.android;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;

/** Fixed-destination native account transport. No SDK or shared browser cookie jar. */
final class VocciHttp {
    static final String CLERK = "https://clerk.vocci.ai/v1/";
    static final String BINDINGS = "https://durer.proactiva.ai/api/device/app/bind-list";
    static final String USER_AGENT = "MossRingCompanion/1.0 (Android native setup)";
    static final int MAX_BYTES = 1024 * 1024;
    interface TokenSink { void save(String authorization) throws Exception; }
    interface Transport {
        Reply request(String method, String url, String authorization, String form, TokenSink rotation) throws Exception;
    }
    static final class Reply {
        final int status, retrySeconds;
        final String authorization, body;
        Reply(int status, String authorization, String body, int retrySeconds) {
            this.status = status; this.authorization = authorization; this.body = body; this.retrySeconds = retrySeconds;
        }
    }
    static final class Failure extends Exception {
        final String code;
        final int retrySeconds;
        Failure(String code) { this(code, 0); }
        Failure(String code, int retrySeconds) { super(code); this.code = code; this.retrySeconds = retrySeconds; }
    }
    static String clerk(String path) throws Failure {
        if (!path.matches("client|client/sign_ins|client/sign_ins/sia_[A-Za-z0-9]+/(prepare_first_factor|attempt_first_factor|attempt_second_factor)|client/sessions/sess_[A-Za-z0-9]+/(tokens|remove)"))
            throw new Failure("invalid_auth_path");
        return CLERK + path + "?__clerk_api_version=2025-04-10&_is_native=true";
    }
    static void destination(String method, String url) throws Failure {
        if (url.equals(BINDINGS) && method.equals("GET")) return;
        if (!url.startsWith(CLERK) || !url.endsWith("?__clerk_api_version=2025-04-10&_is_native=true")) throw new Failure("invalid_auth_destination");
        String path = url.substring(CLERK.length(), url.indexOf('?'));
        if (!clerk(path).equals(url) || !(method.equals("GET") && path.equals("client") || method.equals("POST") && !path.equals("client")))
            throw new Failure("invalid_auth_destination");
    }
    static String header(String value) throws Failure {
        if (value == null || !value.matches("[A-Za-z0-9_. -]{1,6000}")) throw new Failure("invalid_auth_token");
        return value;
    }
    static String form(String... fields) throws Exception {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < fields.length; i += 2) {
            if (out.length() > 0) out.append('&');
            out.append(URLEncoder.encode(fields[i], "UTF-8")).append('=').append(URLEncoder.encode(fields[i + 1], "UTF-8"));
        }
        return out.toString();
    }
    static void success(Reply reply) throws Failure {
        if (reply.status >= 200 && reply.status < 300) return;
        if (reply.status >= 300 && reply.status < 400) throw new Failure("auth_redirect_rejected");
        if (reply.status == 429) throw new Failure("auth_rate_limited", Math.max(60, reply.retrySeconds));
        if (reply.status == 403) throw new Failure("auth_service_rejected");
        // Map allowlisted remote codes only; never return vendor messages or response bodies.
        String code = "";
        try { code = new JSONObject(reply.body).getJSONArray("errors").getJSONObject(0).getString("code"); }
        catch (Exception ignored) { }
        if (code.equals("form_code_incorrect")) throw new Failure("auth_code_incorrect");
        if (code.equals("verification_expired") || code.equals("form_code_expired")) throw new Failure("auth_code_expired");
        if (code.equals("form_identifier_not_found")) throw new Failure("auth_account_not_found");
        if (reply.status == 401) throw new Failure("auth_session_expired");
        throw new Failure("auth_request_failed");
    }
    static byte[] read(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192]; int size;
            long deadline = System.nanoTime() + 20_000_000_000L;
            while ((size = stream.read(chunk)) != -1) {
                if (size > MAX_BYTES - out.size()) throw new Failure("auth_response_too_large");
                if (System.nanoTime() > deadline) throw new Failure("auth_network_unavailable");
                out.write(chunk, 0, size);
            }
            return out.toByteArray();
        }
    }
    static final Transport NETWORK = (method, url, authorization, form, rotation) -> {
        destination(method, url);
        // This app installs no CookieHandler. Refuse a future shared handler rather than use it.
        if (CookieHandler.getDefault() != null) throw new Failure("auth_cookie_handler_present");
        HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
        try {
            connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(15000); connection.setRequestMethod(method);
            connection.setRequestProperty("User-Agent", USER_AGENT); connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (authorization != null) connection.setRequestProperty("Authorization", header(authorization));
            if (method.equals("POST")) {
                byte[] bytes = form.getBytes(StandardCharsets.UTF_8);
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode(), retry = 0;
            try { retry = Math.min(3600, Math.max(0, Integer.parseInt(connection.getHeaderField("Retry-After")))); }
            catch (Exception ignored) { }
            // Read rotation before reading the body; retain it even if body reading fails.
            String rotated = connection.getHeaderField("Authorization");
            if (rotated != null) rotation.save(header(rotated));
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = stream == null ? "" : new String(read(stream), StandardCharsets.UTF_8);
            return new Reply(status, rotated, body, retry);
        } catch (Failure known) { throw known; }
        catch (Exception unavailable) { throw new Failure("auth_network_unavailable"); }
        finally { connection.disconnect(); }
    };
}
