package ai.moss.android;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Encrypted retained configuration. Development ADB provisioning is a separate trust boundary. */
final class SecretStore {
    private final File file;
    private final String alias;
    SecretStore(Context context) { this(context, "moss-vocci-config", "config.enc"); }
    SecretStore(Context context, String alias, String name) {
        this.alias = alias; file = new File(context.getNoBackupFilesDir(), name);
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (file.exists()) throw new IllegalStateException("key_unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    void save(JSONObject config) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(alias.getBytes(StandardCharsets.UTF_8));
        byte[] plain = config.toString().getBytes(StandardCharsets.UTF_8);
        try {
            byte[] encrypted = cipher.doFinal(plain), iv = cipher.getIV();
            PrivateFiles.write(file, ByteBuffer.allocate(1 + iv.length + encrypted.length).put((byte) iv.length).put(iv).put(encrypted).array());
        } finally { Arrays.fill(plain, (byte) 0); }
    }
    JSONObject load() throws Exception {
        byte[] bytes = PrivateFiles.read(file, 16384);
        if (bytes.length < 30 || bytes[0] != 12) throw new IllegalArgumentException("encrypted_config");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, bytes, 1, 12));
        cipher.updateAAD(alias.getBytes(StandardCharsets.UTF_8));
        byte[] plain = cipher.doFinal(bytes, 13, bytes.length - 13);
        try { return new JSONObject(new String(plain, StandardCharsets.UTF_8)); }
        finally { Arrays.fill(plain, (byte) 0); }
    }
    boolean exists() { return file.exists(); }
    void delete() throws Exception {
        if (file.exists() && !file.delete()) throw new java.io.IOException("secret_cleanup");
        new android.util.AtomicFile(file).delete();
    }
    static void assertSameIdentity(JSONObject previous, JSONObject config) throws Exception {
        for (String field : new String[]{"address", "sn", "deviceId", "origin", "ownerId"})
            if (!previous.getString(field).equals(config.getString(field))) throw new IllegalArgumentException("configuration_identity_change");
    }
    void provision(Context context) throws Exception {
        File bootstrap = new File(context.getFilesDir(), "bootstrap.json");
        if (!bootstrap.exists()) return;
        byte[] bytes;
        // Remove the one-use private bootstrap even when its bounded read fails.
        try { bytes = PrivateFiles.read(bootstrap, 12000); }
        finally { if (!bootstrap.delete()) throw new IllegalStateException("bootstrap_cleanup"); }
        try {
            JSONObject config = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            config.put("address", RingAuth.canonicalMac(config.getString("address")));
            for (String field : new String[]{"bindKey", "sn", "deviceId"}) {
                if (config.getString(field).isEmpty() || config.getString(field).length() > 256) throw new IllegalArgumentException("config");
            }
            MossClient client = new MossClient(config);
            String owner = client.owner();
            config.put("ownerId", owner);
            if (file.exists()) {
                JSONObject previous = load();
                assertSameIdentity(previous, config);
            }
            save(config);
        } finally { Arrays.fill(bytes, (byte) 0); }
    }
}
