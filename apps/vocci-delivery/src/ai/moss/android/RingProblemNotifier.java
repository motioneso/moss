package ai.moss.android;

import android.app.*;
import android.content.Context;
import android.content.Intent;

/** Posts, keeps or clears the "Ring problems" notification from the current Hardware card. */
final class RingProblemNotifier {
    static final String CHANNEL = "ring-problems";
    private static final int ID = 3552;
    private static final String POSTED = "problem-posted";

    static synchronized void sync(Context context) {
        try {
            HardwareCard now = HardwareCard.read(context);
            String due = RingProblem.text(now.card, now.delivering);
            android.content.SharedPreferences memory = context.getSharedPreferences("ring-problems", Context.MODE_PRIVATE);
            String posted = memory.getString(POSTED, "");
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            switch (RingProblem.step(due, posted)) {
                case POST:
                    manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Ring problems", NotificationManager.IMPORTANCE_DEFAULT));
                    Intent open = new Intent(context, DeliveryActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    manager.notify(ID, new Notification.Builder(context, CHANNEL).setContentTitle("Ring problem").setContentText(due)
                        .setContentIntent(PendingIntent.getActivity(context, 4, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                        .setSmallIcon(android.R.drawable.stat_notify_error).setAutoCancel(true).setCategory(Notification.CATEGORY_STATUS).build());
                    memory.edit().putString(POSTED, due).apply();
                    break;
                case CLEAR:
                    manager.cancel(ID); memory.edit().putString(POSTED, "").apply();
                    break;
                default: break;
            }
        } catch (RuntimeException unavailable) { /* A notification failure must never affect delivery. */ }
    }
}
