package ai.moss.android;

import android.content.*;

/** Swiping the long-recording reminder away. Never starts the delivery service. */
public final class ReminderDismissal extends BroadcastReceiver {
    static final String WINDOW = "reminderWindow";
    @Override public void onReceive(Context context, Intent intent) {
        RecordingReminder.SHARED.dismiss(intent.getLongExtra(WINDOW, 0));
    }
}
