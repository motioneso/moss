package ai.moss.android;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class DirectFetchTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("direct fetch assertion"); }
    private static byte[] start(String name, int size) {
        byte[] filename = name.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(filename.length + 6).order(ByteOrder.LITTLE_ENDIAN)
            .put((byte) 1).put((byte) filename.length).put(filename).putInt(size).array();
    }
    public static void main(String[] args) throws Exception {
        String name = "amsg_1700000000_mono.opus";
        byte[] good = {0, 1, 1, 1, 1, 1};
        // Only a hold-to-talk first part can take the direct path.
        check(DirectFetch.eligible(name));
        check(!DirectFetch.eligible(""));
        check(!DirectFetch.eligible("1700000000_mono.opus"));
        check(!DirectFetch.eligible("amsg_1700000000_mono.json"));
        check(!DirectFetch.eligible("amsg_1700000000_mono_001.opus"));
        check(!DirectFetch.eligible("../amsg_1700000000_mono.opus"));
        // A complete, continuous recording of the announced size is accepted.
        check(DirectFetch.accept(name, good.length, true, good));
        // Anything that disagrees or looks partial falls back to the full listing.
        check(!DirectFetch.accept(name, good.length + 1, true, good));
        check(!DirectFetch.accept(name, good.length - 1, true, good));
        check(!DirectFetch.accept(name, good.length, false, good));
        check(!DirectFetch.accept("amsg_1700000000_mono_001.opus", good.length, true, good));
        check(!DirectFetch.accept(name, 0, true, new byte[0]));
        check(!DirectFetch.accept(name, 3, true, new byte[]{0, 5, 1}));
        byte[] gap = {0, 1, 1, 2, 1, 1};
        check(!DirectFetch.accept(name, gap.length, true, gap));
        // A file at the ring's 5 MiB cut may have unseen tails, so it never goes direct.
        // The buffer parses cleanly, so the size cut is the only reason it is refused.
        byte[] cut = new byte[DirectFetch.TAIL_CUT];
        for (int at = 0, seq = 0; at < cut.length; seq++) {
            int size = Math.min(255, cut.length - at - 2);
            cut[at] = (byte) seq; cut[at + 1] = (byte) size;
            at += size + 2;
        }
        check(RingProtocol.packetCount(cut) > 0);
        check(!DirectFetch.accept(name, cut.length, true, cut));
        // A transfer that learns its size takes it from the start message and still refuses a short file.
        ByteArrayOutputStream sink = new ByteArrayOutputStream();
        RingProtocol.Transfer learning = new RingProtocol.Transfer(name, sink);
        check(learning.size() == -1);
        learning.control(start(name, 3)); check(learning.size() == 3);
        learning.append(new byte[]{1, 2});
        try { learning.control(new byte[]{2}); throw new AssertionError("short transfer ended"); }
        catch (IllegalArgumentException expected) { check(!learning.ended()); }
        learning.append(new byte[]{3}); learning.control(new byte[]{2});
        check(learning.ended() && Arrays.equals(sink.toByteArray(), new byte[]{1, 2, 3}));
        // A wrong name of the same length, a zero size and an oversized start are refused.
        check("amsg_1700000000_mona.opus".length() == name.length());
        for (byte[] bad : new byte[][]{start("amsg_1700000000_mona.opus", 3), start(name, 0), start(name, RingProtocol.PACKET_LIMIT + 1)}) {
            RingProtocol.Transfer refused = new RingProtocol.Transfer(name, new ByteArrayOutputStream());
            try { refused.control(bad); throw new AssertionError("bad start accepted"); }
            catch (IllegalArgumentException expected) { check(refused.size() == -1); }
        }
        try { new RingProtocol.Transfer("../x.opus", new ByteArrayOutputStream()); throw new AssertionError("bad name accepted"); }
        catch (IllegalArgumentException expected) { }
    }
}
