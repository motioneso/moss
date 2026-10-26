package ai.moss.vocci;

import android.graphics.drawable.GradientDrawable;
import android.widget.*;
import android.view.View;

/** Stable native status card: one state action, plus a text cancellation link while pending. */
final class HomeStatusCard extends LinearLayout {
    private final NativeTheme theme;
    private final TextView title, detail;
    private Button action;
    private final TextView cancel;
    private HomeStatus.Action current;
    private boolean primary;
    HomeStatusCard(NativeTheme theme) {
        super(theme.activity); this.theme = theme; setOrientation(VERTICAL);
        setPadding(theme.dp(16), theme.dp(16), theme.dp(16), theme.dp(16));
        GradientDrawable ground = new GradientDrawable(); ground.setColor(theme.surface);
        ground.setStroke(theme.dp(1), theme.line); ground.setCornerRadius(theme.dp(6)); setBackground(ground);
        title = theme.text(20, false); title.setTextColor(theme.text); title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setAccessibilityHeading(true); addView(title);
        detail = theme.text(13, false); addView(detail, spacing());
        cancel = theme.textLink(() -> {}); cancel.setText("Cancel connection request");
    }
    private LinearLayout.LayoutParams spacing() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = theme.dp(12); return params;
    }
    void update(HomeStatus.Card card, String description, Runnable run, Runnable cancelRequest) {
        NativeTheme.update(title, card.title);
        GradientDrawable dot = new GradientDrawable(); dot.setShape(GradientDrawable.OVAL);
        dot.setColor(card.action == HomeStatus.Action.START || card.action == HomeStatus.Action.NONE ? theme.muted : theme.accentText);
        dot.setBounds(0, 0, theme.dp(11), theme.dp(11)); title.setCompoundDrawables(dot, null, null, null);
        title.setCompoundDrawablePadding(theme.dp(10));
        NativeTheme.update(detail, description); detail.setVisibility(description.isEmpty() ? GONE : VISIBLE);
        if (action == null || current != card.action || primary != card.primary) {
            if (action != null) removeView(action);
            action = theme.button(run, card.primary); addView(action, 2, spacing());
            current = card.action; primary = card.primary;
        }
        NativeTheme.update(action, card.label); action.setOnClickListener(v -> run.run());
        action.setVisibility(card.action == HomeStatus.Action.NONE ? GONE : VISIBLE);
        if (cancel.getParent() == null) addView(cancel, spacing());
        cancel.setVisibility(card.cancel ? VISIBLE : GONE); cancel.setOnClickListener(v -> cancelRequest.run());
    }
    void busy(boolean busy) { if (action != null) action.setEnabled(!busy); cancel.setEnabled(!busy); }
}
