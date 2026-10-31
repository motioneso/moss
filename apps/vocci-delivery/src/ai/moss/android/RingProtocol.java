package ai.moss.android;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** Only finished-file listing/reads; deliberately no destructive command builder. */
final class RingProtocol {
    static final int PACKET_LIMIT = 32 * 1024 * 1024, SIDECAR_LIMIT = 256 * 1024;
    static final String SERVICE = "b75497db-806e-42b1-9e60-5871ca2e504b";
    static final String WRITE = "b75497dc-806e-42b1-9e60-5871ca2e504b";
    static final String UART = "b75497dd-806e-42b1-9e60-5871ca2e504b";
    static final String FILE = "e49a3003-f69a-11e8-8eb2-f2801f1b9fd1";
    static boolean validName(String name) {
        return name.matches("(?:amsg_)?[0-9]{10}_[A-Za-z0-9_-]{1,24}\\.(opus|json)");
    }
    /** True for a numbered tail (name_001.opus) of a recording whose first part is also listed. */
    static boolean isContinuation(String name, Map<String, Integer> inventory) {
        return name.matches(".+_[0-9]{3}\\.opus") && inventory.containsKey(name.substring(0, name.length() - 9) + ".opus");
    }
    /** The ring cuts long recordings into 5 MiB files; the tails are named name_001.opus, name_002.opus and so on. */
    static List<String> continuations(String packetName, Map<String, Integer> inventory) {
        String base = packetName.substring(0, packetName.length() - 5);
        List<String> parts = new ArrayList<>();
        for (int n = 1; n < 1000; n++) {
            String part = String.format("%s_%03d.opus", base, n);
            if (!inventory.containsKey(part)) break;
            parts.add(part);
        }
        return parts;
    }
    static byte[] read(String name) {
        if (!validName(name)) throw new IllegalArgumentException("filename");
        byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
        byte[] payload = new byte[bytes.length + 6];
        payload[0] = 1; payload[1] = (byte) bytes.length;
        System.arraycopy(bytes, 0, payload, 2, bytes.length);
        return RingAuth.frame(0x12, payload); // trailing LE offset is zero
    }
    static boolean inventoryComplete(byte[] payload) {
        return Arrays.equals(payload, new byte[]{1, 0, 0, 0, 0, 0});
    }
    static final class Entry {
        final String name;
        final int size;
        Entry(String name, int size) { this.name = name; this.size = size; }
        static Entry parse(byte[] payload) {
            if (payload.length < 7 || payload[0] != 0 || (payload[5] & 255) + 6 != payload.length)
                throw new IllegalArgumentException("inventory");
            String name = new String(payload, 6, payload.length - 6, StandardCharsets.UTF_8);
            long size = Integer.toUnsignedLong(ByteBuffer.wrap(payload, 1, 4).getInt());
            if (!validName(name) || size == 0 || size > Integer.MAX_VALUE) return null;
            return new Entry(name, (int) size);
        }
    }
    static final class Transfer {
        final String name;
        private int expected;
        private boolean started, ended;
        private final OutputStream data;
        private int received;
        Transfer(String name, int expected, OutputStream data) {
            int limit = name.endsWith(".opus") ? PACKET_LIMIT : SIDECAR_LIMIT;
            if (!validName(name) || expected < 1 || expected > limit)
                throw new IllegalArgumentException("transfer limit");
            this.name = name; this.expected = expected; this.data = java.util.Objects.requireNonNull(data);
        }
        /** A transfer whose size is learned from the ring's start message. */
        Transfer(String name, OutputStream data) {
            if (!validName(name)) throw new IllegalArgumentException("transfer limit");
            this.name = name; this.expected = -1; this.data = java.util.Objects.requireNonNull(data);
        }
        /** The announced size, or -1 before a learning transfer has started. */
        int size() { return expected; }
        void control(byte[] payload) {
            if (Arrays.equals(payload, new byte[]{2})) {
                if (!started || ended || received != expected) throw new IllegalArgumentException("incomplete");
                ended = true; return;
            }
            int n = name.length();
            if (expected == -1 && !started && payload.length == n + 6) {
                long size = Integer.toUnsignedLong(ByteBuffer.wrap(payload, n + 2, 4).order(ByteOrder.LITTLE_ENDIAN).getInt());
                if (size < 1 || size > (name.endsWith(".opus") ? PACKET_LIMIT : SIDECAR_LIMIT)) throw new IllegalArgumentException("transfer limit");
                int announced = (int) size;
                if (payload[0] != 1 || (payload[1] & 255) != n || !name.equals(new String(payload, 2, n, StandardCharsets.UTF_8)))
                    throw new IllegalArgumentException("transfer start");
                expected = announced; started = true; return;
            }
            if (started || payload.length != n + 6 || payload[0] != 1 || (payload[1] & 255) != n ||
                !name.equals(new String(payload, 2, n, StandardCharsets.UTF_8)) ||
                ByteBuffer.wrap(payload, n + 2, 4).order(ByteOrder.LITTLE_ENDIAN).getInt() != expected)
                throw new IllegalArgumentException("transfer start");
            started = true;
        }
        void append(byte[] bytes) throws IOException {
            if (!started || ended || bytes.length > expected - received)
                throw new IllegalArgumentException("unexpected file bytes");
            data.write(bytes, 0, bytes.length); received += bytes.length;
        }
        boolean ended() { return ended; }

    }
    static int packetCount(byte[] bytes) {
        try { return packetCount(new java.io.ByteArrayInputStream(bytes)); }
        catch (IOException impossible) { throw new IllegalStateException(impossible); }
    }
    static int packetCount(InputStream input) throws IOException {
        PacketReader reader = new PacketReader(input);
        byte[] packet = new byte[255];
        int count = 0;
        while (reader.next(packet) != 0) count++;
        if (count == 0) throw new IllegalArgumentException("empty packets");
        return count;
    }
    static final class PacketReader {
        private final InputStream input;
        private int previous = -1;
        PacketReader(InputStream input) { this.input = java.util.Objects.requireNonNull(input); }
        int next(byte[] packet) throws IOException {
            int sequence = input.read();
            if (sequence == -1) return 0;
            int size = input.read();
            if (size <= 0 || size > packet.length || (previous >= 0 && sequence != (previous + 1) % 256))
                throw new IllegalArgumentException("packet gap/length");
            int offset = 0;
            while (offset < size) {
                int read = input.read(packet, offset, size - offset);
                if (read <= 0) throw new IllegalArgumentException("packet header/length");
                offset += read;
            }
            previous = sequence;
            return size;
        }
    }
}
