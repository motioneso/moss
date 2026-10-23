package ai.moss.vocci;

import java.util.*;
import org.json.*;

/** Account inventory; cloud identity is still subject to physical ring proof. */
final class VocciBindings {
    static List<JSONObject> parse(String body) throws Exception {
        Object decoded = new JSONTokener(body).nextValue();
        if (decoded instanceof JSONObject) {
            JSONObject envelope = (JSONObject) decoded;
            if (!Boolean.TRUE.equals(envelope.opt("success")) || !envelope.has("code")) throw new VocciHttp.Failure("binding_lookup_rejected");
            decoded = envelope.get("data");
        }
        if (!(decoded instanceof JSONArray)) throw new VocciHttp.Failure("binding_response_invalid");
        JSONArray rows = (JSONArray) decoded;
        if (rows.length() > 128) throw new VocciHttp.Failure("binding_response_invalid");
        List<JSONObject> result = new ArrayList<>();
        Set<String> addresses = new HashSet<>(), serials = new HashSet<>(), ids = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            String address;
            try {
                String mac = field(row, "macAddress");
                if (!mac.matches("(?i)[0-9a-f]{12}|([0-9a-f]{2}:){5}[0-9a-f]{2}|([0-9a-f]{2}-){5}[0-9a-f]{2}"))
                    throw new IllegalArgumentException();
                address = RingAuth.canonicalMac(mac);
            }
            catch (Exception invalid) { throw new VocciHttp.Failure("binding_response_invalid"); }
            String serial = field(row, "sn"), id = field(row, "deviceId"), key = field(row, "bindKey");
            if (!addresses.add(address) || !serials.add(serial) || !ids.add(id)) throw new VocciHttp.Failure("binding_identity_ambiguous");
            result.add(new JSONObject().put("address", address).put("sn", serial).put("deviceId", id).put("bindKey", key));
        }
        return result;
    }
    static JSONObject selected(JSONObject binding) throws Exception {
        JSONObject selected = new JSONObject();
        for (String name : new String[]{"address", "sn", "deviceId", "bindKey"}) selected.put(name, field(binding, name));
        String address = selected.getString("address");
        if (!address.equals(RingAuth.canonicalMac(address))) throw new VocciHttp.Failure("binding_response_invalid");
        return selected;
    }
    private static String field(JSONObject row, String name) throws Exception {
        Object value = row.opt(name);
        if (!(value instanceof String)) throw new VocciHttp.Failure("binding_response_invalid");
        String text = (String) value;
        if (text.isEmpty() || text.length() > 256 || !text.equals(text.trim()) || text.matches("(?s).*\\p{Cntrl}.*")) throw new VocciHttp.Failure("binding_response_invalid");
        return text;
    }
}
