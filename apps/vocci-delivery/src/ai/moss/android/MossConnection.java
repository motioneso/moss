package ai.moss.android;

import android.content.Context;
import android.net.Uri;
import org.json.JSONObject;

/** Reads the saved Moss link, from the finished setup or from a link still waiting for a ring. */
final class MossConnection {
    final FirstOpen.Link link;
    /** Null unless the link is saved. */
    final Uri origin;
    final String accountName;
    /** True when a ring setup is saved, not just the Moss link. */
    final boolean committed;
    /** Origin of an approval still in progress, else empty. */
    final String approvingOrigin;

    private MossConnection(FirstOpen.Link link, Uri origin, String accountName, boolean committed, String approvingOrigin) {
        this.link = link; this.origin = origin; this.accountName = accountName; this.committed = committed; this.approvingOrigin = approvingOrigin;
    }

    static MossConnection read(Context context) {
        SecretStore store = new SecretStore(context);
        if (store.exists()) try {
            JSONObject config = store.load();
            Uri saved = web(config.getString("origin"));
            if (saved != null) return new MossConnection(FirstOpen.Link.LINKED, saved, config.optString("accountName", config.optString("ownerId")), true, "");
        } catch (Exception unreadable) { return broken(); }
        else try {
            SetupLink.Status status = new SetupLink(context).status();
            switch (status.phase) {
                case EMPTY: return new MossConnection(FirstOpen.Link.NONE, null, "", false, "");
                case APPROVAL: case CONFIRMING: return new MossConnection(FirstOpen.Link.APPROVING, null, "", false, status.origin);
                case LINKED: case COMMITTED: {
                    Uri saved = web(status.origin);
                    if (saved != null) return new MossConnection(FirstOpen.Link.LINKED, saved, status.accountName, status.phase == SetupLink.Phase.COMMITTED, "");
                }
                default: return broken();
            }
        } catch (Exception unreadable) { return broken(); }
        return broken();
    }

    private static MossConnection broken() { return new MossConnection(FirstOpen.Link.BROKEN, null, "", false, ""); }

    private static Uri web(String value) {
        Uri uri = Uri.parse(value);
        return ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) && uri.getHost() != null ? uri : null;
    }
}
