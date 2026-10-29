package ai.moss.android;

import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.view.*;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.*;

/** A flat, ruled native settings link, with one accessible target and scalable text. */
final class SettingsRow extends LinearLayout {
    private final TextView title, detail, arrow;
    private final NativeTheme theme;
    SettingsRow(NativeTheme theme) {
        super(theme.activity); this.theme = theme; setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL);
        setPadding(0, theme.dp(16), 0, theme.dp(16)); setMinimumHeight(theme.dp(64));
        LinearLayout copy = new LinearLayout(theme.activity); copy.setOrientation(VERTICAL);
        title = theme.text(17, false); title.setTextColor(theme.text);
        detail = theme.text(13, false); copy.addView(title);
        LinearLayout.LayoutParams spacing = new LinearLayout.LayoutParams(-1, -2); spacing.topMargin = theme.dp(4);
        copy.addView(detail, spacing); addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        arrow = theme.text(20, false); arrow.setText("›"); arrow.setPadding(theme.dp(16), 0, 0, 0); addView(arrow);
        setBackground(new RippleDrawable(ColorStateList.valueOf((theme.accentText & 0xffffff) | 0x33000000), null, null));
        setFocusable(true); setClickable(true);
        copy.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName(Button.class.getName());
            }
        });
    }
    void update(String label, String description, Runnable action) { update(label, description, "", 0, action); }
    /** A trailing word replaces the chevron. A null action makes the row plain text. */
    void update(String label, String description, String trailing, int trailingColor, Runnable action) {
        NativeTheme.update(title, label); NativeTheme.update(detail, description);
        detail.setVisibility(description.isEmpty() ? GONE : VISIBLE);
        NativeTheme.update(arrow, trailing.isEmpty() ? "›" : trailing);
        arrow.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, trailing.isEmpty() ? 20 : 13);
        arrow.setTextColor(trailing.isEmpty() ? theme.muted : trailingColor);
        arrow.setVisibility(action == null && trailing.isEmpty() ? GONE : VISIBLE);
        setContentDescription(description.isEmpty() ? label : label + ". " + description);
        setClickable(action != null); setFocusable(action != null);
        setOnClickListener(action == null ? null : v -> action.run());
    }
    /** Horizontal padding for rows that sit inside a bordered group. */
    SettingsRow inset(int horizontal) { setPadding(horizontal, getPaddingTop(), horizontal, getPaddingBottom()); return this; }
}
