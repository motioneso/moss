package ai.moss.android;

import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class PrivateFiles {
    static byte[] read(File file, int limit) throws IOException {
        try (FileInputStream in = new AtomicFile(file).openRead()) {
            byte[] bytes = in.readNBytes(limit + 1);
            if (bytes.length > limit) throw new IOException("file_limit");
            return bytes;
        }
    }
    static JSONObject json(File file) throws Exception {
        return new JSONObject(new String(read(file, 8 * 1024 * 1024), StandardCharsets.UTF_8));
    }
    interface Writer { void write(FileOutputStream output) throws Exception; }
    static void write(File file, byte[] bytes) throws IOException {
        try { write(file, output -> output.write(bytes)); }
        catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("storage_write", error); }
    }
    static void write(File file, Writer writer) throws Exception {
        if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IOException("storage_unavailable");
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream out = atomic.startWrite();
        try { writer.write(out); atomic.finishWrite(out); }
        catch (Exception e) { atomic.failWrite(out); throw e; }
    }
    static void json(File file, JSONObject value) throws IOException {
        write(file, value.toString().getBytes(StandardCharsets.UTF_8));
    }
}
