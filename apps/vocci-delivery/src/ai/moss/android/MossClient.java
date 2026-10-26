package ai.moss.android;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.Arrays;
import org.json.JSONObject;

final class MossClient implements VoiceDelivery.Port, ResumableUpload.Port {
    static final class Rejected extends IOException {
        final int status;
        Rejected(int status) { super("http_rejected"); this.status = status; }
        boolean terminal() { return status != 408 && status != 429 && status < 500; }
    }
    private final String origin, cookie, credential;
    static String origin(String value) throws Exception {
        URI uri = new URI(value);
        if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null ||
            (uri.getRawPath() != null && !uri.getRawPath().isEmpty()) ||
            !(uri.getScheme().equals("https") || (uri.getScheme().equals("http") &&
              (uri.getHost().equals("127.0.0.1") || uri.getHost().equals("localhost") || uri.getHost().equals("[::1]")))))
            throw new IllegalArgumentException("origin");
        return uri.toString();
    }
    MossClient(JSONObject config) throws Exception {
        origin = origin(config.getString("origin"));
        credential = config.optString("credential"); cookie = config.optString("cookie");
        if (!credential.isEmpty()) {
            if (!credential.matches("vr1_[A-Za-z0-9_-]{43}") || !cookie.isEmpty()) throw new IllegalArgumentException("credential");
        } else if (cookie.isEmpty() || cookie.length() > 8192 || cookie.contains("\n") || cookie.contains("\r")) throw new IllegalArgumentException("cookie");
    }
    private JSONObject request(String method, String path, byte[] body) throws Exception {
        return request(method, path, body, "application/json");
    }
    private JSONObject request(String method, String path, byte[] body, String contentType) throws Exception {
        return request(origin, cookie, credential, method, path, body, contentType);
    }
    static JSONObject linkRequest(String origin, String path, JSONObject body) throws Exception {
        if (!Arrays.asList("/api/companion/pair", "/api/companion/pair/redeem", "/api/companion/pair/cancel").contains(path)) throw new IllegalArgumentException("link_path");
        return request(origin(origin), "", "", "POST", path, body.toString().getBytes(StandardCharsets.UTF_8), "application/json");
    }
    private static JSONObject request(String origin, String cookie, String credential, String method, String path, byte[] body, String contentType) throws Exception {
        // Android supplies a form Content-Type for an empty POST. Explicit JSON
        // null preserves the receiver's no-body contract without that implicit type.
        if (body == null && method.equals("POST")) body = "null".getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(60000);
            if (!cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
            if (!credential.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + credential);
            connection.setRequestMethod(method);
            if (body != null) {
                if (body.length > 8 * 1024 * 1024) throw new IllegalArgumentException("body_limit");
                connection.setRequestProperty("Content-Type", contentType);
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            }
            int status = connection.getResponseCode();
            if (status == 204) return new JSONObject();
            if (status != 200 && status != 202) throw new Rejected(status);
            try (InputStream in = connection.getInputStream()) {
                byte[] response = in.readNBytes(65537);
                if (response.length > 65536) throw new IOException("response_limit");
                return new JSONObject(new String(response, StandardCharsets.UTF_8));
            }
        } finally { connection.disconnect(); }
    }
    String owner() throws Exception {
        JSONObject session = request("GET", credential.isEmpty() ? "/api/auth/get-session" : "/api/companion/ring-session", null);
        return uuid(credential.isEmpty() ? session.getJSONObject("user").getString("id") : session.getString("ownerId"));
    }
    void logout() throws Exception { if (!credential.isEmpty()) request("POST", "/api/companion/ring-logout", null); }
    JSONObject accept(byte[] frozen) throws Exception { return status(request("POST", "/api/meetings/recording-imports", frozen)); }
    @Override public JSONObject poll(String id) throws Exception { return status(request("GET", "/api/meetings/recording-imports/" + uuid(id), null)); }
    @Override public JSONObject enable(JSONObject snapshot) throws Exception {
        return request("POST", "/api/meetings/voice-enablement", snapshot.toString().getBytes(StandardCharsets.UTF_8));
    }
    @Override public JSONObject disable(String id) throws Exception {
        return request("POST", "/api/meetings/voice-enablement/" + uuid(id) + "/disable", null);
    }
    JSONObject acceptVoice(byte[] frozen) throws Exception { return voiceStatus(request("POST", "/api/meetings/voice-recordings", frozen)); }
    @Override public JSONObject pollVoice(String id) throws Exception { return voiceStatus(request("GET", "/api/meetings/voice-recordings/" + uuid(id), null)); }
    JSONObject retryVoice(String id) throws Exception { return voiceStatus(request("POST", "/api/meetings/voice-recordings/" + uuid(id) + "/retry", null)); }
    @Override public JSONObject reserveUpload(byte[] manifest) throws Exception { return request("POST", "/api/meetings/recording-uploads", manifest); }
    @Override public JSONObject uploadProgress(String id) throws Exception { return request("GET", "/api/meetings/recording-uploads/" + uuid(id), null); }
    @Override public JSONObject putChunk(String id, String kind, int index, byte[] bytes) throws Exception {
        if (!Arrays.asList("packets", "sidecar", "wav").contains(kind) || index < 0 || index > 255 || bytes.length > 1024 * 1024) throw new IllegalArgumentException("chunk");
        return request("PUT", "/api/meetings/recording-uploads/" + uuid(id) + "/" + kind + "/" + index, bytes, "application/octet-stream");
    }
    @Override public JSONObject finalizeUpload(String id) throws Exception { return request("POST", "/api/meetings/recording-uploads/" + uuid(id) + "/finalize", null); }
    JSONObject chat(String id) throws Exception {
        JSONObject value = request("GET", "/api/chat/voice-requests/" + uuid(id), null);
        uuid(value.getString("id")); uuid(value.getString("threadId")); uuid(value.getString("sourceDeviceId"));
        for (String key : new String[]{"userMessageId", "assistantMessageId"}) if (!value.isNull(key)) uuid(value.getString(key));
        if (!Arrays.asList("no-speech", "ready-to-send", "queued", "dispatching", "replied", "interrupted").contains(value.getString("state"))) throw new IOException("invalid_status");
        return value;
    }
    private JSONObject voiceStatus(JSONObject value) throws Exception {
        uuid(value.getString("id"));
        if (!value.isNull("voiceRequestId")) uuid(value.getString("voiceRequestId"));
        if (!value.getString("intent").equals("voice-request") || !Arrays.asList("queued", "transcribing", "complete", "failed").contains(value.getString("state"))) throw new IOException("invalid_status");
        return value;
    }
    static String uuid(String id) { if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("uuid"); return id; }
    private JSONObject status(JSONObject value) throws Exception {
        uuid(value.getString("id")); uuid(value.getString("meetingId"));
        String state = value.getString("state"), mode = value.getString("mode");
        if (!(state.equals("queued") || state.equals("transcribing") || state.equals("complete") || state.equals("failed")) ||
            !(mode.equals("normal") || mode.equals("voice-request"))) throw new IOException("invalid_status");
        return value;
    }
}
