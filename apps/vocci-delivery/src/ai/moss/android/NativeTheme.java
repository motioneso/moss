package ai.moss.android;

import android.app.Activity;
import android.content.res.*;
import android.graphics.Typeface;
import android.graphics.drawable.*;
import android.util.TypedValue;
import android.view.View;
import android.view.WindowInsetsController;
import android.widget.*;

/** Park Press native roles, mapped from apps/web/src/styles/tokens.css.
 * Hallmark: editorial / forest / ruled sections. Critique: P5 H4 E4 S5 R5 V4. */
final class NativeTheme {
    final Activity activity;
    final boolean dark;
    final int paper, surface, line, text, muted, accent, accentText, onAccent, warn, danger;
    private final Typeface display;
    private final Typeface sans = Typeface.create("sans-serif", Typeface.NORMAL);
    NativeTheme(Activity activity) {
        this.activity = activity; dark = isDark(activity);
        paper = dark ? 0xff1c1a16 : 0xfff2eee4;
        surface = dark ? 0xff232019 : 0xfffaf8f1;
        line = dark ? 0xff514c42 : 0xffc6cbbc;
        text = dark ? 0xffece7dc : 0xff282c25;
        muted = dark ? 0xffb7b1a2 : 0xff676c60;
        accent = 0xff294b39; accentText = dark ? 0xff79a68d : accent;
        warn = dark ? 0xffd9a24a : 0xffb87a1f; danger = dark ? 0xffe07a68 : 0xffa63a2a;
        onAccent = dark ? 0xfff4fbf6 : 0xfff2eee4;
        display = Typeface.createFromAsset(activity.getAssets(), "fonts/Archivo-Black.ttf");
    }
    static boolean isDark(Activity activity) {
        return (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }
    void window() {
        activity.getWindow().setBackgroundDrawable(new ColorDrawable(paper));
        activity.getWindow().setDecorFitsSystemWindows(false);
        int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        activity.getWindow().getDecorView().getWindowInsetsController().setSystemBarsAppearance(dark ? 0 : light, light);
    }
    int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    TextView text(int size, boolean heading) {
        TextView view = new TextView(activity);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, size); view.setTextColor(heading ? text : muted);
        view.setTypeface(heading ? display : sans); view.setIncludeFontPadding(false);
        view.setLineSpacing(0, heading ? 1.12f : 1.35f);
        if (heading) { view.setLetterSpacing(-0.025f); view.setAccessibilityHeading(true); }
        return view;
    }
    TextView eyebrow() {
        TextView view = text(11, false); view.setTextColor(accentText);
        view.setTypeface(Typeface.create(sans, Typeface.BOLD)); view.setLetterSpacing(0.1f); return view;
    }
    TextView groupLabel(String value) {
        TextView view = text(11, false); view.setText(value.toUpperCase(java.util.Locale.ROOT));
        view.setLetterSpacing(0.08f); view.setAccessibilityHeading(true); return view;
    }
    Button button(Runnable action, boolean primary) {
        Button view = new Button(activity);
        view.setAllCaps(false); view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        view.setTypeface(Typeface.create(sans, Typeface.BOLD));
        view.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled}, new int[]{}}, new int[]{muted, primary ? onAccent : accentText}));
        view.setMinHeight(dp(48)); view.setMinimumHeight(dp(48)); view.setPadding(dp(16), dp(12), dp(16), dp(12));
        StateListDrawable background = new StateListDrawable();
        background.addState(new int[]{-android.R.attr.state_enabled}, buttonGround(false, false));
        background.addState(new int[]{android.R.attr.state_focused}, buttonGround(primary, true));
        background.addState(new int[]{}, buttonGround(primary, false));
        view.setBackground(new RippleDrawable(ColorStateList.valueOf((accentText & 0x00ffffff) | 0x33000000), background, null));
        view.setElevation(0); view.setStateListAnimator(null); view.setOnClickListener(v -> action.run()); return view;
    }
    TextView textLink(Runnable action) {
        TextView view = text(15, false); view.setTextColor(accentText);
        view.setPaintFlags(view.getPaintFlags() | android.graphics.Paint.UNDERLINE_TEXT_FLAG);
        view.setMinHeight(dp(48)); view.setGravity(android.view.Gravity.CENTER_VERTICAL);
        view.setFocusable(true); view.setClickable(true); view.setOnClickListener(v -> action.run());
        view.setBackground(new RippleDrawable(ColorStateList.valueOf((accentText & 0xffffff) | 0x33000000), null, null));
        return view;
    }
    private GradientDrawable buttonGround(boolean primary, boolean focused) {
        GradientDrawable ground = new GradientDrawable(); ground.setColor(primary ? accent : surface); ground.setCornerRadius(dp(4));
        ground.setStroke(dp(focused ? 2 : 1), focused ? (primary ? onAccent : accentText) : (primary ? accent : line)); return ground;
    }
    void toggle(Switch view) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15); view.setTextColor(text); view.setTypeface(sans);
        view.setMinHeight(dp(48)); view.setPadding(0, dp(12), 0, dp(12)); view.setSwitchPadding(dp(16));
        int[][] states = {new int[]{android.R.attr.state_checked}, new int[]{}};
        view.setThumbTintList(new ColorStateList(states, new int[]{accentText, muted}));
        view.setTrackTintList(new ColorStateList(states, new int[]{accent, muted}));
    }
    static void update(TextView view, String value) {
        if (!view.getText().toString().equals(value)) view.setText(value);
    }
}
