package ai.moss.vocci;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Only finished-file listing/reads; deliberately no destructive command builder. */
final class RingProtocol {
    static final int PACKET_LIMIT = 1024 * 1024, SIDECAR_LIMIT = 64 * 1024;
    static final String SERVICE = "b75497db-806e-42b1-9e60-5871ca2e504b";
    static final String WRITE = "b75497dc-806e-42b1-9e60-5871ca2e504b";
    static final String UART = "b75497dd-806e-42b1-9e60-5871ca2e504b";
    static final String FILE = "e49a3003-f69a-11e8-8eb2-f2801f1b9fd1";
    static boolean validName(String name) {
        return name.matches("(?:amsg_)?[0-9]{10}_[A-Za-z0-9_-]{1,24}\\.(opus|json)");
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
        final int expected;
        private boolean started, ended;
        private final ByteArrayOutputStream data = new ByteArrayOutputStream();
        Transfer(String name, int expected) {
            int limit = name.endsWith(".opus") ? PACKET_LIMIT : SIDECAR_LIMIT;
            if (!validName(name) || expected < 1 || expected > limit)
                throw new IllegalArgumentException("transfer limit");
            this.name = name; this.expected = expected;
        }
        void control(byte[] payload) {
            if (Arrays.equals(payload, new byte[]{2})) {
                if (!started || ended || data.size() != expected) throw new IllegalArgumentException("incomplete");
                ended = true; return;
            }
            int n = name.length();
            if (started || payload.length != n + 6 || payload[0] != 1 || (payload[1] & 255) != n ||
                !name.equals(new String(payload, 2, n, StandardCharsets.UTF_8)) ||
                ByteBuffer.wrap(payload, n + 2, 4).order(ByteOrder.LITTLE_ENDIAN).getInt() != expected)
                throw new IllegalArgumentException("transfer start");
            started = true;
        }
        void append(byte[] bytes) {
            if (!started || ended || data.size() + bytes.length > expected)
                throw new IllegalArgumentException("unexpected file bytes");
            data.write(bytes, 0, bytes.length);
        }
        boolean ended() { return ended; }
        byte[] result() {
            if (!ended) throw new IllegalStateException("incomplete");
            return data.toByteArray();
        }
    }
    static int packetCount(byte[] bytes) {
        int offset = 0, count = 0, previous = -1;
        while (offset < bytes.length) {
            if (offset + 2 > bytes.length) throw new IllegalArgumentException("packet header");
            int sequence = bytes[offset++] & 255, size = bytes[offset++] & 255;
            if (size == 0 || offset + size > bytes.length || (previous >= 0 && sequence != (previous + 1) % 256))
                throw new IllegalArgumentException("packet gap/length");
            previous = sequence; offset += size; count++;
        }
        if (count == 0) throw new IllegalArgumentException("empty packets");
        return count;
    }
}
