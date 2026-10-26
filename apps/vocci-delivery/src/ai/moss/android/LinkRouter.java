package ai.moss.android;

import java.net.URI;
import java.util.Locale;

/** Decides where a link tapped inside the Moss web view goes. Plain Java so host tests cover it. */
final class LinkRouter {
    enum Route { STAY, HARDWARE, BROWSER, SYSTEM, BLOCK }

    private LinkRouter() {}

    static Route decide(String origin, String target, boolean mainFrame) {
        URI to = parse(target);
        if (to == null || to.getScheme() == null) return Route.BLOCK;
        String scheme = to.getScheme().toLowerCase(Locale.ROOT);
        if ("moss-android".equals(scheme)) return mainFrame && isHardware(to) ? Route.HARDWARE : Route.BLOCK;
        if ("http".equals(scheme) || "https".equals(scheme)) {
            URI from = parse(origin);
            return from != null && sameOrigin(from, to) ? Route.STAY : Route.BROWSER;
        }
        switch (scheme) {
            case "intent": case "javascript": case "file": case "content": case "data": case "about": case "blob": return Route.BLOCK;
            default: return Route.SYSTEM;
        }
    }

    /** Only the exact Hardware address opens the native page. */
    static boolean isHardware(URI uri) {
        String path = uri.getRawPath();
        return "moss-android".equalsIgnoreCase(uri.getScheme()) && "hardware".equalsIgnoreCase(uri.getHost()) && uri.getPort() == -1 &&
            uri.getRawUserInfo() == null && (path == null || path.isEmpty() || "/".equals(path)) && uri.getRawQuery() == null && uri.getRawFragment() == null;
    }

    static boolean sameOrigin(URI origin, URI target) {
        return origin.getScheme() != null && origin.getScheme().equalsIgnoreCase(target.getScheme()) && origin.getHost() != null &&
            origin.getHost().equalsIgnoreCase(target.getHost()) && port(origin) == port(target);
    }

    private static int port(URI uri) {
        return uri.getPort() != -1 ? uri.getPort() : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static URI parse(String value) {
        try { return value == null ? null : new URI(value); } catch (Exception malformed) { return null; }
    }
}
