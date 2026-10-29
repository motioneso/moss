package ai.moss.android;

import android.content.res.ColorStateList;
import android.graphics.drawable.RippleDrawable;
import android.view.*;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.*;

/** A switch row with a title and a detail line. The whole row is one accessible target. */
final class ToggleRow extends LinearLayout {
    private final TextView title, detail;
    private final Switch control;
    private boolean updating;
    ToggleRow(NativeTheme theme) {
        super(theme.activity); setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL);
        setPadding(theme.dp(16), theme.dp(14), theme.dp(16), theme.dp(14)); setMinimumHeight(theme.dp(64));
        LinearLayout copy = new LinearLayout(theme.activity); copy.setOrientation(VERTICAL);
        title = theme.text(17, false); title.setTextColor(theme.text); detail = theme.text(13, false);
        copy.addView(title);
        LinearLayout.LayoutParams spacing = new LinearLayout.LayoutParams(-1, -2); spacing.topMargin = theme.dp(4);
        copy.addView(detail, spacing); addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        control = new Switch(theme.activity); control.setClickable(false); control.setFocusable(false);
        int[][] states = {new int[]{android.R.attr.state_checked}, new int[]{}};
        control.setThumbTintList(new ColorStateList(states, new int[]{theme.accentText, theme.muted}));
        control.setTrackTintList(new ColorStateList(states, new int[]{theme.accent, theme.muted}));
        LinearLayout.LayoutParams side = new LinearLayout.LayoutParams(-2, -2); side.leftMargin = theme.dp(16); addView(control, side);
        copy.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        control.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        setBackground(new RippleDrawable(ColorStateList.valueOf((theme.accentText & 0xffffff) | 0x33000000), null, null));
        setFocusable(true);
        setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName(Switch.class.getName()); info.setCheckable(true); info.setChecked(control.isChecked());
            }
        });
    }
    void update(String label, String description, boolean checked, boolean enabled, java.util.function.Consumer<Boolean> change) {
        NativeTheme.update(title, label); NativeTheme.update(detail, description);
        detail.setVisibility(description.isEmpty() ? GONE : VISIBLE);
        setContentDescription(description.isEmpty() ? label : label + ". " + description);
        updating = true; try { control.setChecked(checked); } finally { updating = false; }
        setEnabled(enabled); control.setEnabled(enabled); setAlpha(enabled ? 1f : 0.5f); setClickable(enabled);
        setOnClickListener(v -> { if (!updating) change.accept(!control.isChecked()); });
    }
}
