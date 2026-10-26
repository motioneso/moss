package ai.moss.android;

import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Bounded PCM16 conversion into a seekable canonical 16 kHz mono WAV. */
final class PcmWavWriter {
    private final FileOutputStream output;
    private final long maxBytes;
    private final byte[] pending = new byte[8192];
    private int pendingSize, ratio, lowByte = -1, groupSize, groupTotal;
    private long bytes;
    private boolean finished;

    PcmWavWriter(FileOutputStream output, int maxDurationMs) throws IOException {
        if (maxDurationMs < 1 || maxDurationMs > 7_200_000) throw new IllegalArgumentException("duration_limit");
        this.output = output;
        maxBytes = maxDurationMs * 32L;
        output.write(new byte[44]);
    }
    void format(int rate, int channels) {
        if (finished || channels != 1 || (rate != 16000 && rate != 48000) ||
            (ratio != 0 && ratio != rate / 16000)) throw new IllegalArgumentException("codec_format");
        ratio = rate / 16000;
    }
    void append(ByteBuffer pcm) throws IOException {
        if (finished || ratio == 0) throw new IllegalStateException("codec_format");
        while (pcm.hasRemaining()) {
            int next = pcm.get() & 255;
            if (lowByte < 0) { lowByte = next; continue; }
            groupTotal += (short) (lowByte | (next << 8)); lowByte = -1;
            if (++groupSize != ratio) continue;
            if (bytes + 2 > maxBytes) throw new IllegalArgumentException("duration_limit");
            short sample = (short) (groupTotal / ratio);
            pending[pendingSize++] = (byte) sample;
            pending[pendingSize++] = (byte) (sample >> 8);
            bytes += 2; groupSize = 0; groupTotal = 0;
            if (pendingSize == pending.length) flush();
        }
    }
    void finish() throws IOException {
        if (finished || ratio == 0 || bytes == 0 || lowByte >= 0 || groupSize != 0 || bytes % 32 != 0)
            throw new IllegalArgumentException("pcm_geometry");
        flush();
        ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + (int) bytes)
            .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16)
            .putShort((short) 1).putShort((short) 1).putInt(16000).putInt(32000)
            .putShort((short) 2).putShort((short) 16)
            .put("data".getBytes(StandardCharsets.US_ASCII)).putInt((int) bytes).flip();
        output.getChannel().position(0);
        while (header.hasRemaining()) output.getChannel().write(header);
        finished = true;
    }
    private void flush() throws IOException {
        output.write(pending, 0, pendingSize); pendingSize = 0;
    }
}
