package ai.moss.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.JSONObject;

/** The launcher. Shows the saved Moss site full screen and hands ring settings to the native Hardware page. */
public final class MossActivity extends Activity {
    private static final int PICK_FILE = 7;
    private NativeTheme theme;
    private WebView web;
    private LinearLayout failure;
    private ValueCallback<Uri[]> picker;
    private FrameLayout root;
    private Uri home;
    private boolean failed;

    @Override public void onCreate(Bundle saved) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(saved);
        MossConnection connection = MossConnection.read(this);
        home = connection.origin;
        if (home == null) {
            startActivity(new Intent(this, FirstOpen.choose(connection.link) == FirstOpen.Screen.CONNECT ? ConnectActivity.class : DeliveryActivity.class));
            finish(); return;
        }
        theme = new NativeTheme(this); theme.window();
        root = new FrameLayout(this); root.setBackgroundColor(theme.paper);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        web = newWeb();
        root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        failure = failureView(); failure.setVisibility(View.GONE);
        root.addView(failure, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root); root.requestApplyInsets();
        if (saved != null && web.restoreState(saved) != null) return;
        web.loadUrl(home.toString());
    }

    private WebView newWeb() {
        WebView view = new WebView(this); view.setBackgroundColor(theme.paper);
        configure(view); return view;
    }

    /** A crashed web view cannot recover, so it is replaced with a fresh one. */
    private void replaceWeb() {
        WebView dead = web;
        root.removeView(dead); dead.destroy();
        web = newWeb(); root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
    }

    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " " + marker(this));
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri target = request.getUrl();
                switch (LinkRouter.decide(home.toString(), target.toString(), request.isForMainFrame())) {
                    case STAY: return false;
                    case HARDWARE: startActivity(new Intent(MossActivity.this, DeliveryActivity.class)); return true;
                    case BROWSER: case SYSTEM: openOutside(target); return true;
                    default: return true;
                }
            }
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { failed = false; showFailure(false); }
            @Override public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { failed = true; showFailure(true); }
            }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                failed = true; replaceWeb(); showFailure(true); return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picker != null) picker.onReceiveValue(null);
                picker = callback;
                try { startActivityForResult(params.createIntent(), PICK_FILE); return true; }
                catch (ActivityNotFoundException unavailable) { picker = null; return false; }
            }
        });
    }

    /** Hands a link to the system. Missing apps only produce a short message. */
    private void openOutside(Uri target) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, target)); }
        catch (ActivityNotFoundException unavailable) { Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show(); }
    }

    /** The user agent suffix the web Settings page looks for. */
    static String marker(android.content.Context context) {
        try {
            String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return "MossAndroid/" + (name == null || name.isEmpty() ? "dev" : name);
        } catch (Exception unavailable) { return "MossAndroid/dev"; }
    }

    private LinearLayout failureView() {
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(theme.paper); box.setPadding(theme.dp(24), theme.dp(24), theme.dp(24), theme.dp(24));
        box.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = theme.text(24, true); title.setText("Moss isn’t loading");
        TextView detail = theme.text(15, false); detail.setText("Check your connection, then try again.");
        box.addView(title); box.addView(detail, space(12));
        box.addView(theme.button(() -> { failed = false; showFailure(false); web.loadUrl(home.toString()); }, true), space(24));
        ((Button) box.getChildAt(2)).setText("Try again");
        TextView hardware = theme.textLink(() -> startActivity(new Intent(this, DeliveryActivity.class)));
        hardware.setText("Open Hardware"); box.addView(hardware, space(8));
        return box;
    }
    private LinearLayout.LayoutParams space(int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = theme.dp(top); return params;
    }
    private void showFailure(boolean show) {
        failure.setVisibility(show ? View.VISIBLE : View.GONE); web.setVisibility(show ? View.INVISIBLE : View.VISIBLE);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        if (request != PICK_FILE) { super.onActivityResult(request, result, data); return; }
        if (picker != null) picker.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        picker = null;
    }
    @Override protected void onSaveInstanceState(Bundle saved) { if (web != null) web.saveState(saved); super.onSaveInstanceState(saved); }
    @Override protected void onResume() {
        super.onResume(); if (web != null) web.onResume();
        android.content.Context app = getApplicationContext(); new Thread(() -> RingProblemNotifier.sync(app)).start();
    }
    @Override protected void onPause() { if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        if (picker != null) picker.onReceiveValue(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
    @Override public void onBackPressed() {
        if (web != null && !failed && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
