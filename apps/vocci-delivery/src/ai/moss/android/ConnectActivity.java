package ai.moss.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.*;
import android.text.InputType;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** First open. One field and one button link the app to Moss, with the approval page inside the app. */
public final class ConnectActivity extends Activity {
    private static final long POLL_MS = 3000;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private NativeTheme theme;
    private SetupLink link;
    private EditText address;
    private TextView error;
    private Button connect;
    private LinearLayout form, approval;
    private WebView web;
    private Uri approvalOrigin;
    private boolean busy = true, polling;
    private final Runnable poll = new Runnable() {
        @Override public void run() { if (polling) check(); }
    };

    @Override public void onCreate(Bundle saved) {
        setTheme(NativeTheme.isDark(this) ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(saved);
        theme = new NativeTheme(this); theme.window();
        FrameLayout root = new FrameLayout(this); root.setBackgroundColor(theme.paper);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        form = formView(); approval = approvalView(); approval.setVisibility(View.GONE);
        root.addView(form, new FrameLayout.LayoutParams(-1, -1)); root.addView(approval, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root); root.requestApplyInsets();
        if (saved != null) address.setText(saved.getString("address", ""));
        worker.execute(() -> {
            String resume = "";
            try {
                link = new SetupLink(this);
                SetupLink.Status status = link.status();
                if (status.phase == SetupLink.Phase.LINKED || status.phase == SetupLink.Phase.COMMITTED) { runOnUiThread(this::finishConnected); return; }
                if (status.phase == SetupLink.Phase.APPROVAL || status.phase == SetupLink.Phase.CONFIRMING) resume = status.origin;
            } catch (Exception unreadable) {
                runOnUiThread(() -> { startActivity(new Intent(this, DeliveryActivity.class)); finish(); }); return;
            }
            String origin = resume;
            runOnUiThread(() -> { busy = false; if (!origin.isEmpty()) start(origin); });
        });
    }

    private LinearLayout formView() {
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(theme.dp(24), theme.dp(24), theme.dp(24), theme.dp(24));
        TextView eyebrow = theme.eyebrow(); eyebrow.setText("MOSS"); box.addView(eyebrow);
        TextView title = theme.text(32, true); title.setText("Connect to Moss"); box.addView(title, space(8));
        TextView label = theme.text(15, false); label.setText("Moss address"); box.addView(label, space(28));
        address = new EditText(this); address.setId(3101); address.setSingleLine(true); label.setLabelFor(3101);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); address.setHint("https://your-moss-server");
        address.setTextColor(theme.text); address.setHintTextColor(theme.muted); address.setTextSize(16); address.setMinHeight(theme.dp(48));
        address.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        address.setOnEditorActionListener((v, action, event) -> { submit(); return true; });
        box.addView(address, space(8));
        error = theme.text(14, false); error.setTextColor(theme.danger); error.setVisibility(View.GONE);
        error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); box.addView(error, space(8));
        connect = theme.button(this::submit, true); connect.setText("Connect"); box.addView(connect, space(16));
        return box;
    }

    private LinearLayout approvalView() {
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setBackgroundColor(theme.paper);
        LinearLayout bar = new LinearLayout(this); bar.setOrientation(LinearLayout.HORIZONTAL); bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(theme.dp(16), 0, theme.dp(8), 0);
        TextView name = theme.text(18, true); name.setText("Moss"); bar.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        bar.addView(theme.textLink(this::cancel)); ((TextView) bar.getChildAt(1)).setText("Cancel"); bar.getChildAt(1).setMinimumWidth(theme.dp(48));
        box.addView(bar, new LinearLayout.LayoutParams(-1, theme.dp(56)));
        View rule = new View(this); rule.setBackgroundColor(theme.line); box.addView(rule, new LinearLayout.LayoutParams(-1, theme.dp(1)));
        web = new WebView(this); web.setBackgroundColor(theme.paper); configure(web);
        box.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        View rule2 = new View(this); rule2.setBackgroundColor(theme.line); box.addView(rule2, new LinearLayout.LayoutParams(-1, theme.dp(1)));
        TextView waiting = theme.text(14, false); waiting.setText("Waiting for you to approve…");
        waiting.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); waiting.setPadding(theme.dp(16), theme.dp(14), theme.dp(16), theme.dp(14));
        box.addView(waiting);
        return box;
    }

    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " " + MossActivity.marker(this));
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (approvalOrigin != null && MossActivity.sameOrigin(approvalOrigin, target)) return false;
                if ("http".equals(target.getScheme()) || "https".equals(target.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, target)); } catch (ActivityNotFoundException unavailable) { /* No browser installed. */ }
                }
                return true;
            }
        });
    }

    private LinearLayout.LayoutParams space(int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = theme.dp(top); return params;
    }

    private void submit() {
        if (busy || link == null) return;
        String value = address.getText().toString().trim();
        if (value.isEmpty()) { show("Enter your Moss address."); return; }
        start(value);
    }

    /** Starts or resumes the approval for this address and shows its page in the app. */
    private void start(String origin) {
        busy = true; connect.setEnabled(false); error.setVisibility(View.GONE);
        worker.execute(() -> {
            try {
                String url = link.begin(origin);
                Uri page = Uri.parse(url);
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    approvalOrigin = page; form.setVisibility(View.GONE); approval.setVisibility(View.VISIBLE);
                    web.loadUrl(url); busy = false; polling = true; handler.postDelayed(poll, POLL_MS);
                });
            } catch (Exception failure) { reset(failure); }
        });
    }

    private void check() {
        worker.execute(() -> {
            try {
                if (link.check()) { runOnUiThread(this::finishConnected); return; }
            } catch (Exception failure) { reset(failure); return; }
            runOnUiThread(() -> { if (polling && !isDestroyed()) handler.postDelayed(poll, POLL_MS); });
        });
    }

    private void cancel() {
        if (link == null) return;
        polling = false; handler.removeCallbacks(poll);
        worker.execute(() -> {
            try { link.cancel(); runOnUiThread(() -> show("")); }
            catch (Exception failure) { runOnUiThread(() -> show(SetupMessages.explain(failure))); }
        });
    }

    /** Drops the attempt and returns to the form with one line of explanation. */
    private void reset(Exception failure) {
        String message = SetupMessages.explain(failure);
        try { link.cancel(); } catch (Exception cleanup) { /* The line below still tells the user. */ }
        runOnUiThread(() -> show(message));
    }

    private void show(String message) {
        if (isDestroyed()) return;
        polling = false; handler.removeCallbacks(poll); busy = false;
        approval.setVisibility(View.GONE); form.setVisibility(View.VISIBLE); connect.setEnabled(true);
        web.loadUrl("about:blank");
        error.setText(message); error.setVisibility(message.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void finishConnected() {
        polling = false; handler.removeCallbacks(poll);
        startActivity(new Intent(this, MossActivity.class)); finish();
    }

    @Override protected void onSaveInstanceState(Bundle saved) { saved.putString("address", address.getText().toString()); super.onSaveInstanceState(saved); }
    @Override public void onBackPressed() {
        if (approval.getVisibility() == View.VISIBLE) cancel(); else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        polling = false; handler.removeCallbacks(poll); worker.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
