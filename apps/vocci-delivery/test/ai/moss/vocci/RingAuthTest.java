package ai.moss.vocci;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.ArrayList;

public final class RingAuthTest {
    static void require(boolean condition) { if (!condition) throw new AssertionError(); }
    interface Failing { void run() throws Exception; }
    static void rejects(Failing operation) throws Exception {
        try { operation.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Expected rejection");
    }
    static byte[] response(int command, byte[] payload) {
        byte[] frame = RingAuth.frame(command, payload);
        frame[0] = (byte) 0xbb; frame[1] = (byte) 0x88;
        return frame;
    }
    public static void main(String[] args) throws Exception {
        // Expected values independently produced by Python stdlib hmac, including Unicode key.
        RingAuth.Identity id = new RingAuth.Identity("SN-test", "020000000001", "device-test");
        require(id.mac.equals("02:00:00:00:00:01"));
        byte[] challenge = RingAuth.fields(1, "ring_nonce_42", "19f7fca2d4a2ef8ab0d762dc879508596f550d1db9d188af12732b3ff40cc1c1");
        byte[] actual = RingAuth.startApp("key-ü-123", id, challenge);
        require(Arrays.equals(actual, RingAuth.fields(3, "app_ring_nonce_42", "bdd354b75235e1b733e68ef516bef5338f7fba4ca3614cd519b59836ab3f9830")));
        rejects(() -> RingAuth.startApp("wrong-key", id, challenge));
        rejects(() -> RingAuth.challenge(new byte[]{1, 20, 1}));
        rejects(() -> RingAuth.challenge(RingAuth.fields(1, "nonce", "0".repeat(63))));
        rejects(() -> RingAuth.fields(3, "ü".repeat(128), "proof"));
        require((RingAuth.fields(3, "ü".repeat(127), "proof")[1] & 255) == 254);
        byte[] sn = " SN-test ".getBytes(StandardCharsets.UTF_8);
        byte[] deviceId = " device-test ".getBytes(StandardCharsets.UTF_8);
        byte[] identity = new byte[3 + sn.length + 6 + deviceId.length];
        int offset = 0;
        identity[offset++] = (byte) sn.length;
        System.arraycopy(sn, 0, identity, offset, sn.length); offset += sn.length;
        identity[offset++] = 6;
        byte[] mac = {2,0,0,0,0,1};
        System.arraycopy(mac, 0, identity, offset, 6); offset += 6;
        identity[offset++] = (byte)deviceId.length;
        System.arraycopy(deviceId, 0, identity, offset, deviceId.length);
        require(RingAuth.identity(identity).sn.equals("SN-test"));
        require(RingAuth.identity(identity).deviceId.equals("device-test"));
        rejects(() -> RingAuth.identity(Arrays.copyOf(identity, identity.length - 1)));
        byte[] frame = response(0x82, challenge);
        for (int split = 1; split < frame.length; split++) {
            RingAuth.Decoder decoder = new RingAuth.Decoder();
            ArrayList<Integer> commands = new ArrayList<>();
            RingAuth.Receiver receiver = (command, bytes) -> {
                commands.add(command); require(Arrays.equals(bytes, challenge));
            };
            decoder.accept(Arrays.copyOfRange(frame, 0, split), receiver);
            decoder.accept(Arrays.copyOfRange(frame, split, frame.length), receiver);
            require(commands.size() == 1 && commands.get(0) == 0x82);
        }
        byte[] combined = new byte[frame.length * 2];
        System.arraycopy(frame, 0, combined, 0, frame.length);
        System.arraycopy(frame, 0, combined, frame.length, frame.length);
        ArrayList<Integer> commands = new ArrayList<>();
        new RingAuth.Decoder().accept(combined, (command, bytes) -> commands.add(command));
        require(commands.size() == 2);
        byte[] corrupt = frame.clone(); corrupt[10] ^= 1;
        rejects(() -> new RingAuth.Decoder().accept(corrupt, (command, bytes) -> {}));
        rejects(() -> new RingAuth.Decoder().accept(new byte[]{0,0,0,0,0,1}, (command, bytes) -> {}));
        System.out.println("RingAuth: crypto vectors, wrong-key rejection, lengths, identity, all frame splits, coalescing and corruption passed");
    }
}
