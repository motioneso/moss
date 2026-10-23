package ai.moss.vocci;

import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.view.*;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.*;

/** A flat, ruled native settings link, with one accessible target and scalable text. */
final class SettingsRow extends LinearLayout {
    private final TextView title, detail;
    SettingsRow(NativeTheme theme) {
        super(theme.activity); setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL);
        setPadding(0, theme.dp(16), 0, theme.dp(16)); setMinimumHeight(theme.dp(64));
        LinearLayout copy = new LinearLayout(theme.activity); copy.setOrientation(VERTICAL);
        title = theme.text(17, false); title.setTextColor(theme.text);
        detail = theme.text(13, false); copy.addView(title);
        LinearLayout.LayoutParams spacing = new LinearLayout.LayoutParams(-1, -2); spacing.topMargin = theme.dp(4);
        copy.addView(detail, spacing); addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        TextView arrow = theme.text(20, false); arrow.setText("›"); arrow.setPadding(theme.dp(16), 0, 0, 0); addView(arrow);
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
    void update(String label, String description, Runnable action) {
        NativeTheme.update(title, label); NativeTheme.update(detail, description);
        detail.setVisibility(description.isEmpty() ? GONE : VISIBLE);
        setContentDescription(description.isEmpty() ? label : label + ". " + description);
        setOnClickListener(v -> action.run());
    }
}
