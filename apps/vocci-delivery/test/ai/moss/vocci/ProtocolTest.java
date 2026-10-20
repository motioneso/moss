package ai.moss.vocci;

import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class ProtocolTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    static void rejects(Runnable body) {
        try { body.run(); } catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new AssertionError("accepted invalid input");
    }
    public static void main(String[] args) {
        String name = "amsg_1700000000_mono.opus";
        byte[] filename = name.getBytes(StandardCharsets.UTF_8);
        byte[] start = ByteBuffer.allocate(filename.length + 6).order(ByteOrder.LITTLE_ENDIAN)
            .put((byte) 1).put((byte) filename.length).put(filename).putInt(3).array();
        RingProtocol.Transfer transfer = new RingProtocol.Transfer(name, 3);
        rejects(() -> transfer.append(new byte[]{1}));
        rejects(transfer::result);
        transfer.control(start); transfer.append(new byte[]{1, 2});
        rejects(() -> transfer.control(new byte[]{2}));
        transfer.append(new byte[]{3}); transfer.control(new byte[]{2});
        check(Arrays.equals(transfer.result(), new byte[]{1, 2, 3}));
        rejects(() -> transfer.append(new byte[]{4}));
        rejects(() -> new RingProtocol.Transfer("../private.opus", 3));
        rejects(() -> new RingProtocol.Transfer(name, RingProtocol.PACKET_LIMIT + 1));
        check(RingProtocol.packetCount(new byte[]{(byte)255,1,1,0,1,1}) == 2);
        rejects(() -> RingProtocol.packetCount(new byte[]{0,1,1,2,1,1}));
        rejects(() -> RingProtocol.packetCount(new byte[]{0,5,1}));
        rejects(() -> RingProtocol.packetCount(new byte[0]));
        check(RingProtocol.inventoryComplete(new byte[]{1,0,0,0,0,0}));
        check(!RingProtocol.inventoryComplete(new byte[]{1,0,0,0,1,0}));
        check(!RingProtocol.inventoryComplete(new byte[]{8}));
        byte[] inventory = ByteBuffer.allocate(filename.length + 6).order(ByteOrder.BIG_ENDIAN)
            .put((byte) 0).putInt(56464).put((byte) filename.length).put(filename).array();
        RingProtocol.Entry listed = RingProtocol.Entry.parse(inventory);
        check(listed.name.equals(name) && listed.size == 56464);
        inventory[5]--;
        rejects(() -> RingProtocol.Entry.parse(inventory));
        byte[] query = RingProtocol.read(name);
        check(query[6] == 0x12 && query[7] == 1);
        rejects(() -> RingProtocol.read("1700000000_mono.exe"));
        check(RetryPolicy.delayMs(1) == 30000 && RetryPolicy.delayMs(8) == 1800000);
        check(!RetryPolicy.due(8, 0, Long.MAX_VALUE));
        check(!RetryPolicy.due(1, 100, 99) && RetryPolicy.due(1, 100, 100));
        System.out.println("PASS: strict transfer, incomplete restart, packet continuity, safe reads and bounded retries");
    }
}
