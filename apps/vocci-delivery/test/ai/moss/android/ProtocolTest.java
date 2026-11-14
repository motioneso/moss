package ai.moss.android;

import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class ProtocolTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    interface Checked { void run() throws Exception; }
    static void rejects(Checked body) throws Exception {
        try { body.run(); } catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new AssertionError("accepted invalid input");
    }
    public static void main(String[] args) throws Exception {
        String name = "amsg_1700000000_mono.opus";
        byte[] filename = name.getBytes(StandardCharsets.UTF_8);
        byte[] start = ByteBuffer.allocate(filename.length + 6).order(ByteOrder.LITTLE_ENDIAN)
            .put((byte) 1).put((byte) filename.length).put(filename).putInt(3).array();
        ByteArrayOutputStream received = new ByteArrayOutputStream();
        RingProtocol.Transfer transfer = new RingProtocol.Transfer(name, 3, received);
        rejects(() -> transfer.append(new byte[]{1}));
        check(!transfer.ended());
        transfer.control(start); transfer.append(new byte[]{1, 2});
        rejects(() -> transfer.control(new byte[]{2}));
        transfer.append(new byte[]{3}); transfer.control(new byte[]{2});
        check(Arrays.equals(received.toByteArray(), new byte[]{1, 2, 3}));
        rejects(() -> transfer.append(new byte[]{4}));
        rejects(() -> new RingProtocol.Transfer("../private.opus", 3, received));
        rejects(() -> new RingProtocol.Transfer(name, RingProtocol.PACKET_LIMIT + 1, received));
        check(RingProtocol.packetCount(new byte[]{(byte)255,1,1,0,1,1}) == 2);
        ByteArrayOutputStream sink = new ByteArrayOutputStream();
        RingProtocol.Transfer streaming = new RingProtocol.Transfer(name, 3, sink);
        streaming.control(start); streaming.append(new byte[]{1}); streaming.append(new byte[]{2,3});
        streaming.control(new byte[]{2});
        check(streaming.ended() && Arrays.equals(sink.toByteArray(), received.toByteArray()));
        check(RingProtocol.packetCount(new FilterInputStream(new ByteArrayInputStream(new byte[]{(byte)255,1,1,0,1,1})) {
            @Override public int read(byte[] bytes, int offset, int length) throws IOException { return super.read(bytes, offset, Math.min(length, 1)); }
        }) == 2);
        RingProtocol.Transfer failing = new RingProtocol.Transfer(name, 3, new OutputStream() {
            @Override public void write(int value) throws IOException { throw new IOException("disk full"); }
        });
        failing.control(start);
        try { failing.append(new byte[]{1}); throw new AssertionError("failed sink accepted"); }
        catch (IOException expected) { check(!failing.ended()); }
        rejects(() -> failing.control(new byte[]{2}));
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
        byte[] unsupported = inventory.clone();
        unsupported[unsupported.length - 1] = 'x';
        check(RingProtocol.Entry.parse(unsupported) == null);
        byte[] empty = inventory.clone();
        Arrays.fill(empty, 1, 5, (byte) 0);
        check(RingProtocol.Entry.parse(empty) == null);
        // Filtering one unrelated file must not prevent the next supported entry.
        check(RingProtocol.Entry.parse(inventory).name.equals(name));
        inventory[5]--;
        rejects(() -> RingProtocol.Entry.parse(inventory));
        byte[] query = RingProtocol.read(name);
        check(query[6] == 0x12 && query[7] == 1);
        rejects(() -> RingProtocol.read("1700000000_mono.exe"));
        // While hold-to-talk is on, the first failed cycle retries soon; repeated failures fall back to the slow backoff.
        if (RetryPolicy.holdFailureDelayMs(1) != 2000 || RetryPolicy.holdFailureDelayMs(2) != RetryPolicy.connectionDelayMs(2) || RetryPolicy.holdFailureDelayMs(0) != RetryPolicy.connectionDelayMs(0)) throw new AssertionError("hold retry delay");
        check(RetryPolicy.delayMs(1) == 30000 && RetryPolicy.delayMs(8) == 1800000);
        int failures = 0;
        for (int n = 0; n < 100; n++) failures = RetryPolicy.connectionFailure(failures);
        check(failures == 8 && RetryPolicy.connectionDelayMs(failures) == 1800000);
        check(RetryPolicy.connectionDelayMs(0) == 30000);
        check(!RetryPolicy.due(8, 0, Long.MAX_VALUE));
        check(!RetryPolicy.due(1, 100, 99) && RetryPolicy.due(1, 100, 100));
        // Long recordings arrive as name.opus plus name_001.opus, name_002.opus; a packet can straddle the cut.
        java.util.Map<String, Integer> listing = new java.util.HashMap<>();
        for (String partName : new String[]{"1700000000_mono.opus", "1700000000_mono_001.opus", "1700000000_mono_002.opus", "1700000000_mono_004.opus", "1700000001_mono.opus"}) listing.put(partName, 1);
        check(RingProtocol.continuations("1700000000_mono.opus", listing).equals(java.util.Arrays.asList("1700000000_mono_001.opus", "1700000000_mono_002.opus")));
        check(RingProtocol.continuations("1700000001_mono.opus", listing).isEmpty());
        check(RingProtocol.isContinuation("1700000000_mono_001.opus", listing) && !RingProtocol.isContinuation("1700000000_mono.opus", listing));
        check(!RingProtocol.isContinuation("1700000009_mono_001.opus", listing));
        byte[] stream = new byte[2 + 98 + 2 + 98];
        stream[0] = 7; stream[1] = 98; stream[100] = 8; stream[101] = 98;
        byte[] head = java.util.Arrays.copyOf(stream, 2 + 94), tailBytes = java.util.Arrays.copyOfRange(stream, 2 + 94, stream.length);
        rejects(() -> { RingProtocol.PacketReader r = new RingProtocol.PacketReader(new java.io.ByteArrayInputStream(head)); r.next(new byte[255]); });
        java.io.ByteArrayOutputStream joined = new java.io.ByteArrayOutputStream();
        joined.write(head, 0, head.length); joined.write(tailBytes, 0, tailBytes.length);
        RingProtocol.PacketReader whole = new RingProtocol.PacketReader(new java.io.ByteArrayInputStream(joined.toByteArray()));
        check(whole.next(new byte[255]) == 98 && whole.next(new byte[255]) == 98 && whole.next(new byte[255]) == 0);
        System.out.println("PASS: strict transfer, incomplete restart, packet continuity, safe reads and bounded retries");
    }
}
