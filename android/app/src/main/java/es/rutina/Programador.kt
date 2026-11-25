package es.rutina

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import kotlin.concurrent.thread

/**
 * Programa las alarmas del sistema:
 *  - una alarma exacta (tipo despertador) para la próxima acción, que funciona
 *    aunque el móvil esté en reposo;
 *  - una revisión cada ~30 min para leer los cambios del calendario.
 */
object Programador {
    private const val ACCION = "es.rutina.ACCION"
    private const val REVISAR = "es.rutina.REVISAR"

    fun programar(ctx: Context, motor: Motor = Motor(ctx)) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val accion = alarma(ctx, ACCION, 1)
        val revisar = alarma(ctx, REVISAR, 2)
        am.cancel(accion)
        am.cancel(revisar)
        if (!motor.automatizacion()) return

        val ahora = System.currentTimeMillis()
        motor.siguienteAlarma(ahora)?.let { cuando ->
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cuando, accion)
            } else {
                am.setAlarmClock(AlarmManager.AlarmClockInfo(cuando, abrirApp(ctx)), accion)
            }
        }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, ahora + 30 * Motor.MIN, revisar)
    }

    private fun alarma(ctx: Context, accion: String, codigo: Int) = PendingIntent.getBroadcast(
        ctx, codigo, Intent(ctx, Alarma::class.java).setAction(accion),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun abrirApp(ctx: Context) = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
    )
}

/** Recibe las alarmas (y el reinicio del móvil) y ejecuta lo que toque. */
class Alarma : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val ctx = context.applicationContext
        val pendiente = goAsync()
        thread {
            try {
                val motor = Motor(ctx)
                if (motor.automatizacion()) motor.tick(System.currentTimeMillis())
                Programador.programar(ctx, motor)
            } catch (e: Exception) {
                runCatching { Motor(ctx).anotar(false, "Error inesperado: ${e.message}") }
            } finally {
                pendiente.finish()
            }
        }
    }
}
