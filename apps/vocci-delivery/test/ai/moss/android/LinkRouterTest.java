package ai.moss.android;

public final class LinkRouterTest {
    private static final String HOME = "https://moss.example:8443/";

    private static void check(LinkRouter.Route want, String target, boolean mainFrame, String name) {
        LinkRouter.Route got = LinkRouter.decide(HOME, target, mainFrame);
        if (got != want) throw new AssertionError(name + ": wanted " + want + " got " + got);
    }

    public static void main(String[] args) {
        check(LinkRouter.Route.STAY, "https://moss.example:8443/settings", true, "same origin");
        check(LinkRouter.Route.STAY, "HTTPS://MOSS.example:8443/x?y=1#z", true, "same origin ignores case");
        check(LinkRouter.Route.BROWSER, "https://other.example/", true, "other origin");
        check(LinkRouter.Route.BROWSER, "https://moss.example:9000/", true, "different port");
        check(LinkRouter.Route.BROWSER, "https://moss.example/", true, "default port is not 8443");
        check(LinkRouter.Route.BROWSER, "http://moss.example:8443/", true, "http is not https");
        check(LinkRouter.Route.HARDWARE, "moss-android://hardware", true, "hardware");
        check(LinkRouter.Route.HARDWARE, "moss-android://hardware/", true, "hardware slash");
        check(LinkRouter.Route.BLOCK, "moss-android://hardware", false, "hardware in a frame");
        check(LinkRouter.Route.BLOCK, "moss-android://hardware/x", true, "hardware with path");
        check(LinkRouter.Route.BLOCK, "moss-android://hardware?a=1", true, "hardware with query");
        check(LinkRouter.Route.BLOCK, "moss-android://other", true, "other app address");
        check(LinkRouter.Route.SYSTEM, "mailto:a@b.example", true, "mailto");
        check(LinkRouter.Route.SYSTEM, "tel:+15550100", true, "tel");
        check(LinkRouter.Route.BLOCK, "intent://scan/#Intent;scheme=zxing;end", true, "intent");
        check(LinkRouter.Route.BLOCK, "javascript:alert(1)", true, "javascript");
        check(LinkRouter.Route.BLOCK, "file:///etc/hosts", true, "file");
        check(LinkRouter.Route.BLOCK, "not a url", true, "malformed");
        check(LinkRouter.Route.BLOCK, null, true, "null");
        if (LinkRouter.decide(null, "https://moss.example/", true) != LinkRouter.Route.BROWSER) throw new AssertionError("no origin");
        System.out.println("LinkRouterTest ok");
    }
}
