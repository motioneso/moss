package ai.moss.android;

import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.LinearLayout;
import java.util.*;
import java.util.function.Supplier;

/** A bordered card of rows split by hairlines. Rows keep their view across refreshes, keyed like the page. */
final class SettingsGroup extends LinearLayout {
    private final NativeTheme theme;
    private final Map<String, View> views = new LinkedHashMap<>();
    private final Set<String> used = new HashSet<>();
    private int position;
    SettingsGroup(NativeTheme theme) {
        super(theme.activity); this.theme = theme; setOrientation(VERTICAL);
        GradientDrawable ground = new GradientDrawable(); ground.setColor(theme.surface);
        ground.setStroke(theme.dp(1), theme.line); ground.setCornerRadius(theme.dp(6)); setBackground(ground);
        setClipToOutline(true);
        GradientDrawable hairline = new GradientDrawable(); hairline.setColor(theme.line); hairline.setSize(1, theme.dp(1));
        setDividerDrawable(hairline); setShowDividers(SHOW_DIVIDER_MIDDLE);
    }
    SettingsGroup begin() { position = 0; used.clear(); return this; }
    void end() { for (String key : new ArrayList<>(views.keySet())) if (!used.contains(key)) removeView(views.remove(key)); }
    private <T extends View> T place(String key, Class<T> type, Supplier<T> factory) {
        View view = views.get(key);
        if (view == null) { view = factory.get(); views.put(key, view); }
        used.add(key);
        if (indexOfChild(view) != position) {
            if (view.getParent() == this) removeView(view);
            addView(view, position, new LinearLayout.LayoutParams(-1, -2));
        }
        position++; return type.cast(view);
    }
    void row(String key, String title, String detail, Runnable action) {
        place(key, SettingsRow.class, () -> new SettingsRow(theme).inset(theme.dp(16))).update(title, detail, action);
    }
    void row(String key, String title, String detail, String trailing, int trailingColor, Runnable action) {
        place(key, SettingsRow.class, () -> new SettingsRow(theme).inset(theme.dp(16))).update(title, detail, trailing, trailingColor, action);
    }
    void toggle(String key, String title, String detail, boolean checked, boolean enabled, java.util.function.Consumer<Boolean> change) {
        place(key, ToggleRow.class, () -> new ToggleRow(theme)).update(title, detail, checked, enabled, change);
    }
}
