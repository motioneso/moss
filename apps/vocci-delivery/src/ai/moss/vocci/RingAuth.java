package ai.moss.vocci;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Ported from the independently validated Vocci legacy probe (2026-10-19).
 * Existing-binding AUTH only. No ownership, pairing, or cloud commands. */
final class RingAuth {
    static final String AUTH_UUID = "b75497de-806e-42b1-9e60-5871ca2e504b";
    static final class Identity {
        final String sn, mac, deviceId;
        Identity(String sn, String mac, String deviceId) {
            this.sn = sn; this.mac = canonicalMac(mac); this.deviceId = deviceId;
        }
    }
    static final class Cursor {
        final byte[] bytes;
        int offset;
        Cursor(byte[] bytes, int offset) { this.bytes = bytes; this.offset = offset; }
        byte[] field() {
            if (offset >= bytes.length) throw new IllegalArgumentException("Missing field length");
            int size = bytes[offset++] & 255;
            if (size == 0 || offset + size > bytes.length) throw new IllegalArgumentException("Invalid field length");
            byte[] value = Arrays.copyOfRange(bytes, offset, offset + size);
            offset += size;
            return value;
        }
    }
    static Identity identity(byte[] payload) {
        Cursor cursor = new Cursor(payload, 0);
        String sn = new String(cursor.field(), StandardCharsets.UTF_8).trim();
        byte[] mac = cursor.field();
        String deviceId = new String(cursor.field(), StandardCharsets.UTF_8).trim();
        if (mac.length != 6 || sn.isEmpty() || deviceId.isEmpty() || cursor.offset != payload.length)
            throw new IllegalArgumentException("Invalid identity");
        return new Identity(sn, hex(mac), deviceId);
    }
    static String canonicalMac(String mac) {
        String compact = mac.replaceAll("[^0-9A-Fa-f]", "").toUpperCase(Locale.ROOT);
        if (compact.length() != 12) throw new IllegalArgumentException("Invalid MAC");
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < 12; i += 2) {
            if (i != 0) result.append(':');
            result.append(compact, i, i + 2);
        }
        return result.toString();
    }
    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    static String hmac(String key, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    }
    static String content(Identity identity, String nonce) {
        return identity.deviceId + "_" + identity.sn + "_" + identity.mac + "_" + nonce;
    }
    static String[] challenge(byte[] payload) {
        if (payload.length == 0 || payload[0] != 1) throw new IllegalArgumentException("Not APP_INFO");
        Cursor cursor = new Cursor(payload, 1);
        String nonce = new String(cursor.field(), StandardCharsets.UTF_8);
        String proof = new String(cursor.field(), StandardCharsets.UTF_8);
        if (cursor.offset != payload.length || !proof.matches("[0-9a-f]{64}"))
            throw new IllegalArgumentException("Invalid APP_INFO");
        return new String[]{nonce, proof};
    }
    static byte[] startApp(String bindKey, Identity identity, byte[] payload) throws Exception {
        if (bindKey == null || bindKey.isEmpty()) throw new IllegalArgumentException("Missing key");
        String[] challenge = challenge(payload);
        String keyText = hex(bindKey.getBytes(StandardCharsets.UTF_8));
        String expected = hmac(keyText, content(identity, challenge[0]));
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), challenge[1].getBytes(StandardCharsets.UTF_8)))
            throw new IllegalArgumentException("Device proof mismatch");
        String nonce = "app_" + challenge[0];
        String appKey = hmac(keyText, nonce);
        return fields(3, nonce, hmac(appKey, content(identity, nonce)));
    }
    static byte[] fields(int action, String first, String second) {
        byte[] a = first.getBytes(StandardCharsets.UTF_8), b = second.getBytes(StandardCharsets.UTF_8);
        if (a.length > 255 || b.length > 255) throw new IllegalArgumentException("Field too long");
        byte[] result = new byte[3 + a.length + b.length];
        result[0] = (byte) action; result[1] = (byte) a.length;
        System.arraycopy(a, 0, result, 2, a.length);
        result[2 + a.length] = (byte) b.length;
        System.arraycopy(b, 0, result, 3 + a.length, b.length);
        return result;
    }
    static byte[] frame(int command, byte[] payload) {
        byte[] frame = new byte[payload.length + 10];
        frame[0] = (byte) 0xaa; frame[1] = 0x55; frame[3] = 1;
        int length = payload.length + 1;
        frame[4] = (byte) (length >>> 8); frame[5] = (byte) length;
        frame[6] = (byte) command;
        System.arraycopy(payload, 0, frame, 7, payload.length);
        for (int i = 2; i < frame.length - 3; i++) frame[frame.length - 3] ^= frame[i];
        frame[frame.length - 2] = 0x0d; frame[frame.length - 1] = 0x0a;
        return frame;
    }
    interface Receiver { void receive(int command, byte[] payload); }
    /** Strict bounded response reassembly; supports split/coalesced GATT notifications. */
    static final class Decoder {
        private byte[] buffer = new byte[0];
        void accept(byte[] bytes, Receiver receiver) {
            if (buffer.length + bytes.length > 16384) throw new IllegalArgumentException("AUTH buffer limit");
            byte[] joined = Arrays.copyOf(buffer, buffer.length + bytes.length);
            System.arraycopy(bytes, 0, joined, buffer.length, bytes.length);
            buffer = joined;
            while (buffer.length >= 6) {
                if ((buffer[0] & 255) != 0xbb || (buffer[1] & 255) != 0x88)
                    throw new IllegalArgumentException("Invalid AUTH frame header");
                int size = ((buffer[4] & 255) << 8) | (buffer[5] & 255);
                if (size < 1 || size > 8192) throw new IllegalArgumentException("Invalid AUTH frame size");
                int total = size + 9;
                if (buffer.length < total) return;
                byte sum = 0;
                for (int i = 2; i < total - 3; i++) sum ^= buffer[i];
                if (sum != buffer[total - 3] || buffer[total - 2] != 13 || buffer[total - 1] != 10)
                    throw new IllegalArgumentException("Invalid AUTH checksum/trailer");
                int command = buffer[6] & 255;
                byte[] payload = Arrays.copyOfRange(buffer, 7, total - 3);
                buffer = Arrays.copyOfRange(buffer, total, buffer.length);
                receiver.receive(command, payload);
            }
        }
    }
}
