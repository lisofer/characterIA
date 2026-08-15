package com.lisofer.characteria

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class InvocationForegroundService : Service() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val profileName = intent?.getStringExtra(EXTRA_PROFILE_NAME).orEmpty().ifBlank { "CharacterIA" }
        val active = intent?.getBooleanExtra(EXTRA_ACTIVE, false) == true
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(profileName, active),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else 0,
        )
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Modo invocación",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Mantiene el micrófono activo mientras CharacterIA espera la frase de invocación."
                setShowBadge(false)
            }
        )
    }

    private fun updateNotification(profileName: String, active: Boolean) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(profileName, active))
    }

    private fun buildNotification(profileName: String, active: Boolean) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle(if (active) "$profileName está activo" else "CharacterIA · $profileName")
        .setContentText(
            if (active) "Decí «podés retirarte» para apagarlo."
            else "Esperando «yo te invoco»."
        )
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        )
        .build()

    companion object {
        private const val CHANNEL_ID = "characteria_invocation"
        private const val NOTIFICATION_ID = 4101
        private const val EXTRA_PROFILE_NAME = "profile_name"
        private const val EXTRA_ACTIVE = "active"
        @Volatile private var instance: InvocationForegroundService? = null

        fun start(context: Context, profileName: String, active: Boolean = false) {
            val intent = Intent(context, InvocationForegroundService::class.java)
                .putExtra(EXTRA_PROFILE_NAME, profileName)
                .putExtra(EXTRA_ACTIVE, active)
            ContextCompat.startForegroundService(context, intent)
        }

        fun update(profileName: String, active: Boolean) {
            instance?.updateNotification(profileName, active)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, InvocationForegroundService::class.java))
        }
    }
}
