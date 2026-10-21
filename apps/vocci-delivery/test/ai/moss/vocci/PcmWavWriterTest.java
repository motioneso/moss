package ai.moss.vocci;

import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.Arrays;

public final class PcmWavWriterTest {
    interface Checked { void run() throws Exception; }
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    static void rejects(Checked body) throws Exception {
        try { body.run(); } catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new AssertionError("invalid PCM accepted");
    }
    static byte[] encode(Path file, byte[] input, int rate, int split) throws Exception {
        try (FileOutputStream out = new FileOutputStream(file.toFile())) {
            PcmWavWriter writer = new PcmWavWriter(out, 120000); writer.format(rate, 1);
            writer.append(ByteBuffer.wrap(input, 0, split));
            writer.append(ByteBuffer.wrap(input, split, input.length - split)); writer.finish();
            rejects(writer::finish);
        }
        return Files.readAllBytes(file);
    }
    public static void main(String[] args) throws Exception {
        Path file = Files.createTempFile("vocci-pcm-", ".wav");
        try {
            byte[] source = new byte[96]; ByteBuffer pcm = ByteBuffer.wrap(source).order(ByteOrder.LITTLE_ENDIAN);
            for (int n = 0; n < 16; n++) pcm.putShort((short)(n * 3 - 30)).putShort((short)(n * 3 - 27)).putShort((short)(n * 3 - 24));
            byte[] reference = encode(file, source, 48000, 0);
            check(reference.length == 76);
            ByteBuffer wav = ByteBuffer.wrap(reference).order(ByteOrder.LITTLE_ENDIAN);
            check(wav.getInt(4) == 68 && wav.getInt(24) == 16000 && wav.getInt(40) == 32);
            for (int n = 0; n < 16; n++) check(wav.getShort(44 + n * 2) == n * 3 - 27);
            for (int split = 0; split <= source.length; split++) check(Arrays.equals(reference, encode(file, source, 48000, split)));
            byte[] mono = Arrays.copyOfRange(reference, 44, reference.length);
            for (int split = 0; split <= mono.length; split++) check(Arrays.equals(reference, encode(file, mono, 16000, split)));
            try (FileOutputStream out = new FileOutputStream(file.toFile())) {
                PcmWavWriter writer = new PcmWavWriter(out, 1); writer.format(16000, 1);
                rejects(() -> writer.append(ByteBuffer.wrap(new byte[34])));
            }
            try (FileOutputStream out = new FileOutputStream(file.toFile())) {
                PcmWavWriter writer = new PcmWavWriter(out, 120000);
                rejects(() -> writer.format(44100, 1)); rejects(() -> writer.format(16000, 2));
                writer.format(48000, 1); writer.append(ByteBuffer.wrap(new byte[]{1,2,3}));
                rejects(writer::finish); rejects(() -> writer.format(16000, 1));
            }
            byte[] longer = new byte[96000];
            ByteBuffer longPcm = ByteBuffer.wrap(longer).order(ByteOrder.LITTLE_ENDIAN);
            for (int n = 0; n < 16000; n++) {
                short sample = (short)(n % 1000 - 500);
                longPcm.putShort(sample).putShort(sample).putShort(sample);
            }
            byte[] oneSecond = encode(file, longer, 48000, 0);
            try (FileOutputStream out = new FileOutputStream(file.toFile())) {
                PcmWavWriter writer = new PcmWavWriter(out, 120000); writer.format(48000, 1);
                for (int n = 0; n < longer.length; n += 37)
                    writer.append(ByteBuffer.wrap(longer, n, Math.min(37, longer.length - n)));
                writer.finish();
            }
            check(Arrays.equals(oneSecond, Files.readAllBytes(file)));
            wav = ByteBuffer.wrap(oneSecond).order(ByteOrder.LITTLE_ENDIAN);
            for (int n = 0; n < 16000; n++) check(wav.getShort(44 + n * 2) == n % 1000 - 500);
            // Two hours generated a buffer at a time; neither source nor output is retained in memory.
            try (FileOutputStream out = new FileOutputStream(file.toFile())) {
                PcmWavWriter writer = new PcmWavWriter(out, 7_200_000); writer.format(16000, 1);
                byte[] second = new byte[32000];
                for (int n = 0; n < 7200; n++) writer.append(ByteBuffer.wrap(second));
                writer.finish(); rejects(() -> writer.append(ByteBuffer.wrap(new byte[2])));
            }
            check(Files.size(file) == 230_400_044L);
            System.out.println("PASS: canonical PCM, every byte split, resampling carry, limits and generated two-hour file");
        } finally { Files.deleteIfExists(file); }
    }
}
