package ai.moss.vocci;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

final class MossClient {
    static final class Rejected extends IOException {
        final int status;
        Rejected(int status) { super("http_rejected"); this.status = status; }
        boolean terminal() { return status != 408 && status != 429 && status < 500; }
    }
    private final String origin, cookie;
    MossClient(JSONObject config) throws Exception {
        URI uri = new URI(config.getString("origin"));
        if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null ||
            (uri.getRawPath() != null && !uri.getRawPath().isEmpty()) ||
            !(uri.getScheme().equals("https") || (uri.getScheme().equals("http") &&
              (uri.getHost().equals("127.0.0.1") || uri.getHost().equals("localhost") || uri.getHost().equals("[::1]")))))
            throw new IllegalArgumentException("origin");
        origin = uri.toString(); cookie = config.getString("cookie");
        if (cookie.isEmpty() || cookie.length() > 8192 || cookie.contains("\n") || cookie.contains("\r")) throw new IllegalArgumentException("cookie");
    }
    private JSONObject request(String path, byte[] body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(60000);
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Content-Type", "application/json");
            if (body != null) {
                if (body.length > 8 * 1024 * 1024) throw new IllegalArgumentException("body_limit");
                connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            }
            int status = connection.getResponseCode();
            if (status != 200 && status != 202) throw new Rejected(status);
            try (InputStream in = connection.getInputStream()) {
                byte[] response = in.readNBytes(65537);
                if (response.length > 65536) throw new IOException("response_limit");
                return new JSONObject(new String(response, StandardCharsets.UTF_8));
            }
        } finally { connection.disconnect(); }
    }
    String owner() throws Exception { return uuid(request("/api/auth/get-session", null).getJSONObject("user").getString("id")); }
    JSONObject accept(byte[] frozen) throws Exception { return status(request("/api/meetings/recording-imports", frozen)); }
    JSONObject poll(String id) throws Exception { return status(request("/api/meetings/recording-imports/" + uuid(id), null)); }
    static String uuid(String id) { if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("uuid"); return id; }
    private JSONObject status(JSONObject value) throws Exception {
        uuid(value.getString("id")); uuid(value.getString("meetingId"));
        String state = value.getString("state"), mode = value.getString("mode");
        if (!(state.equals("queued") || state.equals("transcribing") || state.equals("complete") || state.equals("failed")) ||
            !(mode.equals("normal") || mode.equals("voice-request"))) throw new IOException("invalid_status");
        return value;
    }
}
