package ai.moss.vocci;

import android.bluetooth.*;
import android.content.Context;
import org.json.JSONObject;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;

/** Blocking, serialized GATT session, used only on the service worker thread. */
final class RingConnection implements AutoCloseable {
    private static final class Event {
        final String kind;
        final int status;
        final byte[] bytes;
        Event(String kind, int status, byte[] bytes) { this.kind = kind; this.status = status; this.bytes = bytes; }
    }
    private final BlockingQueue<Event> events = new ArrayBlockingQueue<>(2048);
    private final ArrayDeque<Event> pending = new ArrayDeque<>();
    private final RingAuth.Decoder auth = new RingAuth.Decoder(), uart = new RingAuth.Decoder();
    private BluetoothGatt gatt;
    private volatile boolean overflow, closed;
    private String stage = "connect";
    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        private void add(String kind, int status, byte[] bytes) {
            if (!closed && !events.offer(new Event(kind, status, bytes))) overflow = true;
        }
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            add(state == BluetoothProfile.STATE_CONNECTED ? "connected" : "disconnected", status, null);
        }
        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            add("mtu", status == 0 && mtu >= 160 ? 0 : -1, null);
        }
        @Override public void onServicesDiscovered(BluetoothGatt g, int status) { add("services", status, null); }
        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) { add("descriptor", status, null); }
        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) { add("write", status, null); }
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] bytes) {
            add(c.getUuid().toString(), 0, bytes.clone());
        }
    };
    RingConnection(Context context, JSONObject config) throws Exception {
        try {
            BluetoothManager manager = context.getSystemService(BluetoothManager.class);
            if (manager == null || manager.getAdapter() == null || !manager.getAdapter().isEnabled()) throw new IOException("bluetooth_unavailable");
            BluetoothDevice device = manager.getAdapter().getRemoteDevice(config.getString("address"));
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null) throw new IOException("connection_unavailable");
            await("connected"); stage = "mtu";
            if (!gatt.requestMtu(247)) throw new IOException("mtu");
            await("mtu"); stage = "services";
            if (!gatt.discoverServices()) throw new IOException("services");
            await("services"); stage = "subscribe";
            for (String id : new String[]{RingAuth.AUTH_UUID, RingProtocol.UART, RingProtocol.FILE}) {
                BluetoothGattCharacteristic c = characteristic(id);
                BluetoothGattDescriptor d = c.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
                if (d == null || !gatt.setCharacteristicNotification(c, true) ||
                    gatt.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) != BluetoothStatusCodes.SUCCESS)
                    throw new IOException("subscription");
                await("descriptor");
            }
            stage = "identity";
            write(RingAuth.AUTH_UUID, RingAuth.frame(0x80, new byte[0]));
            byte[] identityBytes = response(RingAuth.AUTH_UUID, 0x80);
            RingAuth.Identity observed = RingAuth.identity(identityBytes);
            if (!observed.sn.equals(config.getString("sn")) || !observed.deviceId.equals(config.getString("deviceId")))
                throw new IOException("ring_identity_mismatch");
            RingAuth.Identity identity = new RingAuth.Identity(observed.sn, config.getString("address"), observed.deviceId);
            stage = "challenge";
            write(RingAuth.AUTH_UUID, RingAuth.frame(0x82, new byte[]{1}));
            byte[] challenge = response(RingAuth.AUTH_UUID, 0x82);
            write(RingAuth.AUTH_UUID, RingAuth.frame(0x82, RingAuth.startApp(config.getString("bindKey"), identity, challenge)));
            stage = "start_app";
            byte[] success = response(RingAuth.AUTH_UUID, 0x82);
            if (success.length != 1 || success[0] != 3) throw new IOException("auth_rejected");
        } catch (InterruptedException error) { close(); throw error; }
        catch (Exception error) { close(); throw new IOException("ring_" + stage, error); }
    }
    private Event next() throws Exception {
        if (closed || overflow) throw new IOException("connection_closed");
        Event e = events.poll(20, TimeUnit.SECONDS);
        if (e == null || e.kind.equals("disconnected") || e.status != 0) throw new IOException("gatt_timeout_or_error");
        return e;
    }
    private void await(String kind) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (System.nanoTime() < end) {
            Event e = next();
            if (e.kind.equals(kind)) return;
            pending.add(e);
            if (pending.size() > 2048) throw new IOException("gatt_overflow");
        }
        throw new IOException("gatt_timeout");
    }
    private BluetoothGattCharacteristic characteristic(String id) throws IOException {
        BluetoothGattCharacteristic found = null;
        for (BluetoothGattService service : gatt.getServices()) {
            BluetoothGattCharacteristic candidate = service.getCharacteristic(UUID.fromString(id));
            if (candidate == null) continue;
            if (found != null) throw new IOException("ambiguous_characteristic");
            found = candidate;
        }
        if (found == null) throw new IOException("characteristic_unavailable");
        return found;
    }
    private void write(String id, byte[] frame) throws Exception {
        if (gatt.writeCharacteristic(characteristic(id), frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) != BluetoothStatusCodes.SUCCESS)
            throw new IOException("write_unavailable");
        await("write");
    }
    private final ArrayDeque<byte[]> responses = new ArrayDeque<>();
    private byte[] response(String id, int opcode) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            if (!responses.isEmpty()) return responses.remove();
            Event event = pending.isEmpty() ? next() : pending.remove();
            if (event.kind.equals(id)) {
                (id.equals(RingAuth.AUTH_UUID) ? auth : uart).accept(event.bytes, (command, payload) -> {
                    if (command == opcode) responses.add(payload);
                });
            } else if (event.kind.equals(RingProtocol.FILE)) throw new IOException("orphan_file_bytes");
        }
        throw new IOException("response_timeout");
    }
    Map<String, Integer> inventory() throws Exception {
        stage = "inventory";
        Map<String, Integer> files = new LinkedHashMap<>();
        write(RingProtocol.WRITE, RingAuth.frame(0x11, new byte[0]));
        for (int n = 0; n < 1024; n++) {
            byte[] payload = response(RingProtocol.UART, 0x11);
            if (RingProtocol.inventoryComplete(payload)) return files;
            RingProtocol.Entry entry = RingProtocol.Entry.parse(payload);
            if (entry == null) continue; // Unsupported or empty files cannot poison an otherwise valid inventory.
            if (files.put(entry.name, entry.size) != null) throw new IOException("duplicate_inventory");
        }
        throw new IOException("inventory_limit");
    }
    byte[] retrieve(String name, int size) throws Exception {
        stage = "file";
        RingProtocol.Transfer transfer = new RingProtocol.Transfer(name, size);
        write(RingProtocol.WRITE, RingProtocol.read(name));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(180);
        while (!transfer.ended() && System.nanoTime() < deadline) {
            Event event = pending.isEmpty() ? next() : pending.remove();
            if (event.kind.equals(RingProtocol.FILE)) transfer.append(event.bytes);
            else if (event.kind.equals(RingProtocol.UART)) uart.accept(event.bytes, (command, payload) -> {
                if (command == 0x12) transfer.control(payload);
            });
        }
        return transfer.result();
    }
    @Override public synchronized void close() {
        closed = true;
        if (gatt != null) { gatt.disconnect(); gatt.close(); gatt = null; }
        events.offer(new Event("disconnected", -1, null));
    }
}
