package ai.moss.vocci;

import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class RingTelemetryTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("telemetry assertion"); }
    private static void rejects(Runnable action) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("invalid telemetry accepted");
    }
    private static byte[] storage(int free, int used, int total) {
        return ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putInt(free).putInt(used).putInt(total).array();
    }
    private static byte[] payload(byte[] frame, int expectedCommand) {
        final byte[][] result = new byte[1][];
        check((frame[0] & 255) == 0xaa && frame[1] == 0x55);
        byte[] response = frame.clone(); response[0] = (byte) 0xbb; response[1] = (byte) 0x88;
        new RingAuth.Decoder().accept(response, (command, bytes) -> { check(command == expectedCommand); result[0] = bytes; });
        check(result[0] != null); return result[0];
    }
    public static void main(String[] args) {
        byte[] info = new byte[20]; info[1] = 0x25; info[2] = 1; info[3] = 0x12; info[4] = 3;
        info[6] = 87; info[14] = 5; System.arraycopy("Timon".getBytes(StandardCharsets.UTF_8), 0, info, 15, 5);
        RingTelemetry.Info parsed = RingTelemetry.info(info);
        check(parsed.hardware.equals("2.5.1") && parsed.firmware.equals("1.2.03") && parsed.battery == 87 && parsed.model.equals("Timon"));
        info[6] = (byte) 255; check(RingTelemetry.info(info).battery == -1);
        check(RingTelemetry.info(new byte[12]).model.isEmpty());
        rejects(() -> RingTelemetry.info(new byte[11]));
        byte[] shortModel = info.clone(); shortModel[14] = 6; rejects(() -> RingTelemetry.info(shortModel));
        byte[] badModel = info.clone(); badModel[15] = (byte) 0xff; rejects(() -> RingTelemetry.info(badModel));
        byte[] controlModel = info.clone(); controlModel[15] = 10; rejects(() -> RingTelemetry.info(controlModel));
        RingTelemetry.Storage size = RingTelemetry.storage(storage(1048576, 2097152, 3145728));
        check(size.free == 1048576 && size.used == 2097152 && size.total == 3145728);
        rejects(() -> RingTelemetry.storage(new byte[11]));
        rejects(() -> RingTelemetry.storage(storage(-1, 1, 2)));
        rejects(() -> RingTelemetry.storage(storage(1, -1, 2)));
        rejects(() -> RingTelemetry.storage(storage(0, 0, 0)));
        rejects(() -> RingTelemetry.storage(storage(3, 0, 2)));
        rejects(() -> RingTelemetry.storage(storage(1, 2, 2)));
        check(RingTelemetry.recording(new byte[]{0}).equals("idle"));
        check(RingTelemetry.recording(new byte[]{16}).equals("idle"));
        check(RingTelemetry.recording(new byte[]{1}).equals("recording"));
        check(RingTelemetry.recording(new byte[]{17, 1, 'x'}).equals("hold"));
        check(RingTelemetry.recording(new byte[]{33}).equals("low_battery"));
        check(RingTelemetry.recording(new byte[]{34}).equals("low_storage"));
        check(RingTelemetry.recording(new byte[]{(byte) 255}).equals("unknown"));
        rejects(() -> RingTelemetry.recording(new byte[0]));
        rejects(() -> RingTelemetry.recording(new byte[]{1, 2, 'x'}));
        RingTelemetry observations = new RingTelemetry();
        observations.accept(RingTelemetry.STORAGE, storage(1, 1, 2), 100);
        observations.accept(RingTelemetry.STORAGE, storage(-1, 1, 2), 200);
        check(observations.storage.free == 1 && observations.storageAt == 100);
        observations.accept(RingTelemetry.RECORDING, new byte[]{1}, 100);
        observations.accept(RingTelemetry.RECORDING, new byte[]{0, 2}, 200);
        check(observations.recording.equals("recording") && observations.recordingAt == 100);
        observations.accept(RingTelemetry.RECORDING, new byte[]{127}, 300);
        check(observations.recording.equals("unknown") && observations.recordingAt == 300);
        check(Arrays.equals(payload(RingTelemetry.recordingRequest(), 0x13), new byte[]{2}));
        check(payload(RingTelemetry.storageRequest(), 0x14).length == 0);
        check(Arrays.equals(payload(RingTelemetry.infoRequest(1700000000123L), 0xf2),
            ByteBuffer.allocate(6).order(ByteOrder.BIG_ENDIAN).putInt(1700000000).putShort((short)123).array()));
        rejects(() -> RingTelemetry.infoRequest(-1));
        rejects(() -> RingTelemetry.infoRequest(0x100000000L * 1000));
        System.out.println("PASS: observed legacy status layouts, unknown values, malformed telemetry and non-recording query frames");
    }
}
