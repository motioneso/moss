package ai.moss.vocci;

import android.media.MediaCodec;
import android.media.MediaFormat;
import java.io.ByteArrayOutputStream;
import java.nio.*;
import java.nio.charset.StandardCharsets;

/** Platform Opus decode. Source packets are retained independently of this derived WAV. */
final class OpusWav {
    static byte[] decode(byte[] packets) throws Exception {
        int count = RingProtocol.packetCount(packets);
        MediaCodec codec = MediaCodec.createDecoderByType("audio/opus");
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        int rate = 0, channels = 0;
        try {
            MediaFormat format = MediaFormat.createAudioFormat("audio/opus", 16000, 1);
            ByteBuffer head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
            head.put("OpusHead".getBytes(StandardCharsets.US_ASCII)).put((byte) 1).put((byte) 1).putShort((short) 0).putInt(16000).putShort((short) 0).put((byte) 0);
            format.setByteBuffer("csd-0", ByteBuffer.wrap(head.array()));
            format.setByteBuffer("csd-1", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(0).flip());
            format.setByteBuffer("csd-2", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(80000000L).flip());
            codec.configure(format, null, null, 0); codec.start();
            int offset = 0, submitted = 0; boolean inputEnd = false, outputEnd = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long deadline = System.nanoTime() + 120_000_000_000L;
            while (!outputEnd && System.nanoTime() < deadline) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                if (!inputEnd) {
                    int index = codec.dequeueInputBuffer(1000);
                    if (index >= 0) {
                        if (offset == packets.length) {
                            codec.queueInputBuffer(index, 0, 0, submitted * 60000L, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnd = true;
                        } else {
                            int size = packets[offset + 1] & 255;
                            codec.getInputBuffer(index).put(packets, offset + 2, size);
                            codec.queueInputBuffer(index, 0, size, submitted * 60000L, 0);
                            submitted++; offset += size + 2;
                        }
                    }
                }
                int output = codec.dequeueOutputBuffer(info, 1000);
                if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat actual = codec.getOutputFormat();
                    rate = actual.getInteger(MediaFormat.KEY_SAMPLE_RATE); channels = actual.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (channels != 1 || (rate != 16000 && rate != 48000) ||
                        actual.getInteger(MediaFormat.KEY_PCM_ENCODING, 2) != 2) throw new IllegalArgumentException("codec_format");
                } else if (output >= 0) {
                    ByteBuffer buffer = codec.getOutputBuffer(output);
                    buffer.position(info.offset); buffer.limit(info.offset + info.size);
                    byte[] chunk = new byte[info.size]; buffer.get(chunk); pcm.write(chunk);
                    outputEnd = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    codec.releaseOutputBuffer(output, false);
                    if (pcm.size() > 120 * 48000 * 2) throw new IllegalArgumentException("duration_limit");
                }
            }
            if (!outputEnd || submitted != count || rate == 0 || pcm.size() == 0 || pcm.size() % 2 != 0) throw new IllegalArgumentException("decode_incomplete");
        } finally { codec.release(); }
        byte[] source = pcm.toByteArray();
        int ratio = rate / 16000;
        if (source.length % (2 * ratio) != 0) throw new IllegalArgumentException("pcm_geometry");
        int size = source.length / ratio;
        if (size > 3_840_000) throw new IllegalArgumentException("duration_limit");
        ByteBuffer wav = ByteBuffer.allocate(44 + size).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + size).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII))
            .putInt(16).putShort((short) 1).putShort((short) 1).putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16)
            .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(size);
        // A three-sample box low-pass precedes 48→16 kHz decimation. Not a bit-exact
        // substitute for libopus decoding directly at 16 kHz; retain original packets.
        ByteBuffer samples = ByteBuffer.wrap(source).order(ByteOrder.LITTLE_ENDIAN);
        while (samples.hasRemaining()) {
            int total = 0; for (int n = 0; n < ratio; n++) total += samples.getShort();
            wav.putShort((short) (total / ratio));
        }
        return wav.array();
    }
}
