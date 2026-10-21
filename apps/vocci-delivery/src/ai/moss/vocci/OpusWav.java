package ai.moss.vocci;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.util.AtomicFile;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;

/** Platform Opus decode with bounded packet/PCM buffers and atomic WAV publication. */
final class OpusWav {
    static void decode(File packets, File destination) throws Exception {
        decode(packets, destination, 120000);
    }
    static void decode(File packets, File destination, long maxDurationMs) throws Exception {
        if (maxDurationMs < 1 || maxDurationMs > 7200000) throw new IllegalArgumentException("duration_limit");
        PrivateFiles.write(destination, output -> decode(packets, output, maxDurationMs));
    }
    private static void decode(File packets, FileOutputStream output, long maxDurationMs) throws Exception {
        PcmWavWriter wav = new PcmWavWriter(output, (int) maxDurationMs);
        MediaCodec codec = MediaCodec.createDecoderByType("audio/opus");
        try (InputStream input = new BufferedInputStream(new AtomicFile(packets).openRead())) {
            MediaFormat format = MediaFormat.createAudioFormat("audio/opus", 16000, 1);
            ByteBuffer head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
            head.put("OpusHead".getBytes(StandardCharsets.US_ASCII)).put((byte) 1).put((byte) 1).putShort((short) 0).putInt(16000).putShort((short) 0).put((byte) 0);
            format.setByteBuffer("csd-0", ByteBuffer.wrap(head.array()));
            format.setByteBuffer("csd-1", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(0).flip());
            format.setByteBuffer("csd-2", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(80000000L).flip());
            codec.configure(format, null, null, 0); codec.start();
            int submitted = 0;
            RingProtocol.PacketReader reader = new RingProtocol.PacketReader(input);
            boolean inputEnd = false, outputEnd = false;
            byte[] packet = new byte[255];
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(Math.max(120000, maxDurationMs));
            while (!outputEnd && System.nanoTime() < deadline) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                if (!inputEnd) {
                    int index = codec.dequeueInputBuffer(1000);
                    if (index >= 0) {
                        int size = reader.next(packet);
                        if (size == 0) {
                            codec.queueInputBuffer(index, 0, 0, submitted * 60000L, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputEnd = true;
                        } else {
                            ByteBuffer buffer = codec.getInputBuffer(index);
                            if (buffer == null) throw new IllegalStateException("codec_input");
                            buffer.clear(); buffer.put(packet, 0, size);
                            codec.queueInputBuffer(index, 0, size, submitted * 60000L, 0);
                            submitted++;
                        }
                    }
                }
                int index = codec.dequeueOutputBuffer(info, 1000);
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat actual = codec.getOutputFormat();
                    if (actual.getInteger(MediaFormat.KEY_PCM_ENCODING, 2) != 2)
                        throw new IllegalArgumentException("codec_format");
                    wav.format(actual.getInteger(MediaFormat.KEY_SAMPLE_RATE), actual.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
                } else if (index >= 0) {
                    try {
                        if (info.size != 0) {
                            ByteBuffer buffer = codec.getOutputBuffer(index);
                            if (buffer == null) throw new IllegalStateException("codec_output");
                            buffer.position(info.offset); buffer.limit(info.offset + info.size);
                            wav.append(buffer);
                        }
                        outputEnd = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    } finally { codec.releaseOutputBuffer(index, false); }
                }
            }
            if (!outputEnd || !inputEnd || submitted == 0) throw new IllegalArgumentException("decode_incomplete");
            wav.finish();
        } finally { codec.release(); }
    }
}
