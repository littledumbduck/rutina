package es.rutina

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** Muestra la interfaz (assets/index.html) y le da acceso al Motor. */
class MainActivity : Activity() {
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.addJavascriptInterface(Puente(), "AndroidRutina")
        setContentView(web)
        web.loadUrl("file:///android_asset/index.html")

        if (checkSelfPermission(Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), 1)
        }
        thread { runCatching { Programador.programar(this) } }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        web.reload()
    }

    @Deprecated("Se mantiene por compatibilidad con Android antiguos")
    override fun onBackPressed() {
        // Si el editor de reglas está abierto, «atrás» lo cierra; si no, sale.
        web.evaluateJavascript(
            "(function(){var d=document.getElementById('dlgRegla');if(d&&d.open){d.close();return 1}return 0})()",
        ) { r -> if (r != "1") finish() }
    }

    inner class Puente {
        @JavascriptInterface
        fun llamar(id: String, nombre: String, argumentos: String) {
            thread {
                val (ok, valor) = try {
                    true to json(Motor(this@MainActivity).api(nombre, JSONArray(argumentos)))
                } catch (e: Exception) {
                    false to JSONObject.quote(e.message ?: "Error inesperado")
                }
                runOnUiThread { web.evaluateJavascript("window.__respuesta(${JSONObject.quote(id)}, $ok, $valor)", null) }
            }
        }
    }

    private fun json(v: Any?): String = when (v) {
        null, JSONObject.NULL -> "null"
        is JSONObject, is JSONArray, is Boolean, is Number -> v.toString()
        else -> JSONObject.quote(v.toString())
    }
}
