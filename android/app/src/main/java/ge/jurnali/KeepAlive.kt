package ge.jurnali

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import kotlin.concurrent.thread

/**
 * Keeps the onlineschool session alive while the app is in the background.
 *
 * The refresh token dies after 30 idle minutes, so we renew it every 12. WorkManager
 * can't promise that (Doze pushes periodic work back by hours), so this uses an alarm
 * that is allowed to fire while the phone is idle. Exact when Android lets us, inexact
 * otherwise; with an 18-minute margin the inexact one is usually still on time.
 *
 * While the app is on screen the page refreshes the session itself and we stay out of
 * its way, so the two never use the same refresh token at once.
 */
object KeepAlive {
    private const val INTERVAL_MS = 12 * 60 * 1000L

    /** True while MainActivity is resumed. Main thread only, like onReceive. */
    var foreground = false

    fun schedule(context: Context, delayMs: Long = INTERVAL_MS) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        val at = SystemClock.elapsedRealtime() + delayMs
        val intent = pendingIntent(context)
        val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()
        if (exact) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, intent)
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, intent)
        }
    }

    fun cancel(context: Context) {
        context.getSystemService(AlarmManager::class.java).cancel(pendingIntent(context))
    }

    private fun pendingIntent(context: Context) = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, Receiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    class Receiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val app = context.applicationContext
            val store = SessionStore(app)
            val session = store.load()
            if (session == null || !session.isAlive()) {
                store.clear()
                return
            }
            if (foreground) {
                // The page is handling it. Check back in case the teacher leaves.
                schedule(app)
                return
            }

            val pending = goAsync()
            thread(name = "session-refresh") {
                try {
                    when (val result = refreshSession(store, session)) {
                        is RefreshResult.Renewed -> {
                            store.save(result.session)
                            schedule(app)
                        }
                        RefreshResult.Ended -> store.clear()
                        // Try again soon, while the current refresh token is still good.
                        RefreshResult.Failed -> if (session.isAlive()) schedule(app, 60_000)
                    }
                } finally {
                    pending.finish()
                }
            }
        }
    }
}
