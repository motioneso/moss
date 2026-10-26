package ai.moss.android;

import java.nio.*;
import java.nio.charset.*;
import java.util.Locale;

/** Non-destructive legacy status layouts verified against Vocci 1.1.24/build 333.
 * Optional telemetry is independent of file admission and recording destinations. */
final class RingTelemetry {
    static final int INFO = 0xf2, RECORDING = 0x13, STORAGE = 0x14;
    static final class Info {
        final String hardware, firmware, model;
        final int battery;
        Info(String hardware, String firmware, String model, int battery) {
            this.hardware = hardware; this.firmware = firmware; this.model = model; this.battery = battery;
        }
    }
    static final class Storage {
        final long free, used, total;
        Storage(long free, long used, long total) { this.free = free; this.used = used; this.total = total; }
    }
    Info info;
    Storage storage;
    String recording, recordingSource = "";
    long infoAt, storageAt, recordingAt;
    void accept(int command, byte[] payload, long now) {
        // A malformed optional notification must never abort an audio transfer.
        try {
            if (command == INFO) { Info parsed = info(payload); info = parsed; infoAt = now; }
            else if (command == STORAGE) { Storage parsed = storage(payload); storage = parsed; storageAt = now; }
            else if (command == RECORDING) {
                String parsed = recording(payload);
                String source = payload.length > 1 ? utf8(payload, 2, payload[1] & 255) : "";
                recording = parsed; recordingSource = source; recordingAt = now;
            }
        } catch (IllegalArgumentException invalid) { /* Keep the last valid observation and its original time. */ }
    }
    static Info info(byte[] bytes) {
        if (bytes.length < 12) throw new IllegalArgumentException("ring_info_short");
        String model = "";
        if (bytes.length > 14) {
            int length = bytes[14] & 255;
            if (length > bytes.length - 15) throw new IllegalArgumentException("ring_model_short");
            model = utf8(bytes, 15, length);
        }
        int battery = bytes[6] & 255;
        return new Info(version(bytes[1], bytes[2], false), version(bytes[3], bytes[4], true), model,
            battery <= 100 ? battery : -1);
    }
    private static String version(byte first, byte second, boolean padded) {
        return ((first & 255) >>> 4) + "." + (first & 15) + "." +
            (padded ? String.format(Locale.ROOT, "%02d", second & 255) : Integer.toString(second & 255));
    }
    static Storage storage(byte[] bytes) {
        if (bytes.length < 12) throw new IllegalArgumentException("ring_storage_short");
        ByteBuffer values = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN);
        long free = values.getInt(), used = values.getInt(), total = values.getInt();
        if (free < 0 || used < 0 || total <= 0 || free > total || used > total || free + used != total)
            throw new IllegalArgumentException("ring_storage_invalid");
        return new Storage(free, used, total);
    }
    static String recording(byte[] bytes) {
        if (bytes.length < 1) throw new IllegalArgumentException("ring_recording_short");
        if (bytes.length > 1) {
            int length = bytes[1] & 255;
            if (length > bytes.length - 2) throw new IllegalArgumentException("ring_recording_name_short");
            utf8(bytes, 2, length); // Validate, but do not retain a private source filename in telemetry.
        }
        switch (bytes[0] & 255) {
            case 0: case 16: return "idle";
            case 1: return "recording";
            case 17: return "hold";
            case 32: return "not_bound";
            case 33: return "low_battery";
            case 34: return "low_storage";
            case 35: return "hardware_error";
            default: return "unknown";
        }
    }
    static byte[] infoRequest(long millis) {
        long seconds = millis / 1000;
        if (millis < 0 || seconds > 0xffffffffL) throw new IllegalArgumentException("ring_clock_range");
        // Official info request also aligns the ring clock with the phone. It never controls recording.
        return RingAuth.frame(INFO, ByteBuffer.allocate(6).order(ByteOrder.BIG_ENDIAN)
            .putInt((int) seconds).putShort((short) (millis % 1000)).array());
    }
    static byte[] recordingRequest() { return RingAuth.frame(RECORDING, new byte[]{2}); }
    static byte[] storageRequest() { return RingAuth.frame(STORAGE, new byte[0]); }
    private static String utf8(byte[] bytes, int offset, int length) {
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes, offset, length)).toString();
            for (int n = 0; n < text.length(); n++) if (Character.isISOControl(text.charAt(n)))
                throw new IllegalArgumentException("ring_text_invalid");
            return text;
        } catch (CharacterCodingException error) { throw new IllegalArgumentException("ring_text_invalid", error); }
    }
}
