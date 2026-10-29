package ai.moss.android;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Platform HTTP regression: empty POSTs must not acquire Android's default form media type. */
final class HttpChecks {
    static void run(int port) throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(10000);
            Future<List<String>> captured = worker.submit(() -> {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(10000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    List<String> request = new ArrayList<>();
                    String line; int length = 0;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {
                        request.add(line);
                        if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                    }
                    if (length > 16) throw new IOException("Unexpected test body size");
                    char[] body = new char[length]; int offset = 0;
                    while (offset < length) {
                        int read = reader.read(body, offset, length - offset);
                        if (read < 0) throw new EOFException();
                        offset += read;
                    }
                    request.add(new String(body));
                    socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".getBytes(StandardCharsets.UTF_8));
                    return request;
                }
            });
            MossClient client = new MossClient(new JSONObject().put("origin", "http://127.0.0.1:" + port).put("cookie", "synthetic-http-check"));
            client.finalizeUpload("00000000-0000-4000-8000-000000000001");
            List<String> request = captured.get(10, TimeUnit.SECONDS);
            DeviceChecks.check(request.get(0).startsWith("POST /api/meetings/recording-uploads/"));
            DeviceChecks.check(request.stream().anyMatch(line -> line.equalsIgnoreCase("Content-Type: application/json")));
            DeviceChecks.check(request.get(request.size() - 1).equals("null"));
        } finally { worker.shutdownNow(); }
    }
}
