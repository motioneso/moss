package ai.moss.android;

/** Decides whether a hold-to-talk recording fetched by its announced name may skip the ring file listing. */
final class DirectFetch {
    /** The ring cuts files at 5 MiB; a file this large may have tails the direct path cannot see. */
    static final int TAIL_CUT = 5 * 1024 * 1024;
    private DirectFetch() {}

    static boolean eligible(String name) {
        return name != null && name.startsWith("amsg_") && name.endsWith(".opus") && RingProtocol.validName(name)
            && !name.matches(".+_[0-9]{3}\\.opus");
    }

    /** True only for a complete, continuous recording of exactly the announced size; anything else falls back to the listing. */
    static boolean accept(String name, int announcedSize, boolean sidecarComplete, byte[] packets) {
        if (!eligible(name) || !sidecarComplete || announcedSize < 1 || packets.length != announcedSize || packets.length >= TAIL_CUT) return false;
        try { RingProtocol.packetCount(packets); return true; }
        catch (IllegalArgumentException partial) { return false; }
    }
}
