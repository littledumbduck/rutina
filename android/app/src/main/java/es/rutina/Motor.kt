package es.rutina

import android.content.ContentUris
import android.content.Context
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.text.Normalizer
import java.text.SimpleDateFormat
import java.time.LocalDate
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Error con un mensaje pensado para enseñárselo a la persona. */
class ErrorRutina(mensaje: String) : Exception(mensaje)

/**
 * Toda la lógica de Rutina dentro del móvil. Es la misma que la de la versión
 * web (apps-script/Codigo.gs), pero leyendo el calendario del teléfono.
 */
class Motor(contexto: Context) {

    companion object {
        const val MIN = 60_000L
        const val HORA = 60 * MIN
        const val DIA = 24 * HORA
        const val MARGEN_RETRASO = 15 * MIN
        const val HORIZONTE_PLAN = 26 * HORA
        const val MAX_INTENTOS = 3
        const val MAX_REGISTRO = 40
        const val MAX_ACCIONES_PLAN = 40
        const val PRINCIPAL = "principal"

        val REGIONES = linkedMapOf(
            "eu" to ("Europa central" to "https://openapi.tuyaeu.com"),
            "eu-w" to ("Europa occidental" to "https://openapi-weaz.tuyaeu.com"),
            "us" to ("América (oeste)" to "https://openapi.tuyaus.com"),
            "us-e" to ("América (este)" to "https://openapi-ueaz.tuyaus.com"),
            "cn" to ("China" to "https://openapi.tuyacn.com"),
            "in" to ("India" to "https://openapi.tuyain.com"),
            "sg" to ("Singapur" to "https://openapi-sg.iotbing.com"),
        )
        val INTERRUPTORES = listOf("switch_led", "switch_1", "switch", "led_switch")
        val BRILLOS = listOf("bright_value_v2", "bright_value", "bright_value_1")

        private val candado = Any()
    }

    private val ctx = contexto.applicationContext
    private val prefs = ctx.getSharedPreferences("rutina", Context.MODE_PRIVATE)
    private val zona: TimeZone get() = TimeZone.getDefault()
    private fun ahora() = System.currentTimeMillis()

    // -----------------------------------------------------------------------
    // Almacenamiento
    // -----------------------------------------------------------------------

    private fun obj(k: String): JSONObject? = prefs.getString(k, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    private fun arr(k: String): JSONArray = prefs.getString(k, null)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: JSONArray()
    private fun guardar(k: String, v: Any?) {
        val e = prefs.edit()
        if (v == null) e.remove(k) else e.putString(k, v.toString())
        e.commit()
    }

    fun automatizacion() = prefs.getBoolean("automatizacion", true)

    fun anotar(ok: Boolean, texto: String) = synchronized(candado) {
        val registro = arr("registro")
        val t = texto.take(300)
        val primero = registro.optJSONObject(0)
        if (!ok && primero != null && !primero.optBoolean("ok") && primero.optString("texto") == t) {
            primero.put("t", ahora())
            guardar("registro", registro)
        } else {
            val nuevo = JSONArray().put(JSONObject().put("t", ahora()).put("ok", ok).put("texto", t))
            for (i in 0 until minOf(registro.length(), MAX_REGISTRO - 1)) nuevo.put(registro.get(i))
            guardar("registro", nuevo)
        }
    }

    // -----------------------------------------------------------------------
    // API de Tuya
    // -----------------------------------------------------------------------

    private fun config(): JSONObject {
        val c = obj("config")
        if (c == null || c.optString("accessId").isEmpty() || c.optString("accessSecret").isEmpty()) {
            throw ErrorRutina("Todavía no has conectado Tuya. Pon tu Access ID y Access Secret.")
        }
        return c
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun sha256(s: String) = hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)))
    private fun hmac(s: String, clave: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(clave.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return hex(mac.doFinal(s.toByteArray(Charsets.UTF_8))).uppercase(Locale.ROOT)
    }

    /** sign = HMAC-SHA256(accessId + token + t + MÉTODO\nSHA256(cuerpo)\n\nruta?query, secret) */
    fun firma(id: String, secreto: String, token: String, t: String, metodo: String, ruta: String, cuerpo: String) =
        hmac(id + token + t + listOf(metodo, sha256(cuerpo), "", ruta).joinToString("\n"), secreto)

    private fun conQuery(ruta: String, query: String) = if (query.isEmpty()) ruta else "$ruta?$query"

    private fun tuya(
        c: JSONObject, metodo: String, ruta: String,
        query: Map<String, String> = emptyMap(), cuerpo: JSONObject? = null, reintento: Boolean = false,
    ): Any? {
        val base = (REGIONES[c.optString("region")] ?: REGIONES.getValue("eu")).second
        val esToken = ruta == "/v1.0/token"
        val token = if (esToken) "" else token(c)
        val claves = query.keys.sorted()
        val qFirma = claves.joinToString("&") { "$it=${query[it]}" }
        val qUrl = claves.joinToString("&") { URLEncoder.encode(it, "UTF-8") + "=" + URLEncoder.encode(query[it], "UTF-8") }
        val texto = cuerpo?.toString() ?: ""
        val t = ahora().toString()
        val id = c.getString("accessId")

        val con = URL(base + conQuery(ruta, qUrl)).openConnection() as HttpURLConnection
        val respuesta = try {
            con.requestMethod = metodo
            con.connectTimeout = 7000
            con.readTimeout = 7000
            con.setRequestProperty("client_id", id)
            con.setRequestProperty("sign", firma(id, c.getString("accessSecret"), token, t, metodo, conQuery(ruta, qFirma), texto))
            con.setRequestProperty("t", t)
            con.setRequestProperty("sign_method", "HMAC-SHA256")
            if (token.isNotEmpty()) con.setRequestProperty("access_token", token)
            if (texto.isNotEmpty()) {
                con.doOutput = true
                con.setRequestProperty("Content-Type", "application/json")
                con.outputStream.use { it.write(texto.toByteArray(Charsets.UTF_8)) }
            }
            val codigo = con.responseCode
            val flujo = if (codigo in 200..299) con.inputStream else con.errorStream ?: throw ErrorRutina("Tuya respondió HTTP $codigo.")
            flujo.bufferedReader().use { it.readText() }
        } catch (e: IOException) {
            throw ErrorRutina("No hay conexión con Tuya (${e.message ?: "sin internet"}).")
        } finally {
            con.disconnect()
        }

        val json = runCatching { JSONObject(respuesta) }.getOrNull() ?: throw ErrorRutina("Tuya respondió algo inesperado.")
        if (!json.optBoolean("success")) {
            val codigo = json.optInt("code")
            val msg = json.optString("msg", "error desconocido")
            if (!esToken && !reintento && (codigo == 1010 || codigo == 1011 || msg.contains("token", true))) {
                guardar("token", null)
                return tuya(c, metodo, ruta, query, cuerpo, true)
            }
            throw ErrorRutina(explicarError(codigo, msg))
        }
        return json.opt("result")
    }

    private fun explicarError(codigo: Int, msg: String): String {
        val pista = when {
            codigo == 1004 || msg.contains("sign invalid", true) -> "Revisa que el Access Secret esté bien copiado."
            codigo == 1005 || Regex("client.?id", RegexOption.IGNORE_CASE).containsMatchIn(msg) ->
                "Revisa el Access ID y que la región sea la del proyecto (Central Europe → «Europa central»)."
            codigo == 1106 || msg.contains("permission", true) ->
                "Comprueba que la app Tuya Smart está vinculada al proyecto (Devices → Link App Account) y que el servicio «IoT Core» está activo."
            Regex("expire|trial|subscri", RegexOption.IGNORE_CASE).containsMatchIn(msg) ->
                "Parece que el periodo gratuito de Tuya ha caducado: renuévalo en platform.tuya.com (Cloud → tu proyecto → Service API)."
            else -> ""
        }
        return "Tuya: $msg (código $codigo)" + if (pista.isEmpty()) "" else ". $pista"
    }

    private fun token(c: JSONObject): String {
        val clave = c.optString("region") + ":" + c.optString("accessId")
        obj("token")?.let { if (it.optString("clave") == clave && it.optLong("caduca") > ahora()) return it.getString("valor") }
        val r = tuya(c, "GET", "/v1.0/token", mapOf("grant_type" to "1")) as JSONObject
        val segundos = (r.optLong("expire_time", 7200) - 300).coerceIn(60, 21600)
        guardar("token", JSONObject().put("clave", clave).put("valor", r.getString("access_token")).put("caduca", ahora() + segundos * 1000))
        return r.getString("access_token")
    }

    // -----------------------------------------------------------------------
    // Dispositivos
    // -----------------------------------------------------------------------

    private fun listarDispositivos(c: JSONObject): JSONArray {
        val salida = JSONArray()
        var fila: String? = null
        repeat(10) {
            val q = mutableMapOf("size" to "50")
            fila?.let { q["last_row_key"] = it }
            val r = tuya(c, "GET", "/v1.0/iot-01/associated-users/devices", q) as JSONObject
            val ds = r.optJSONArray("devices") ?: JSONArray()
            for (i in 0 until ds.length()) salida.put(resumir(ds.getJSONObject(i)))
            if (!r.optBoolean("has_more") || r.optString("last_row_key").isEmpty()) return salida
            fila = r.optString("last_row_key")
        }
        return salida
    }

    private fun resumir(d: JSONObject): JSONObject {
        val estado = mutableMapOf<String, Any?>()
        d.optJSONArray("status")?.let { lista ->
            for (i in 0 until lista.length()) lista.optJSONObject(i)?.let { estado[it.optString("code")] = it.opt("value") }
        }
        val codigo = INTERRUPTORES.firstOrNull { it in estado } ?: estado.keys.firstOrNull { it.startsWith("switch") && estado[it] is Boolean }
        return JSONObject()
            .put("id", d.optString("id"))
            .put("nombre", d.optString("name").ifEmpty { d.optString("id") })
            .put("online", d.optBoolean("online"))
            .put("categoria", d.optString("category"))
            .put("producto", d.optString("product_name"))
            .put("encendido", if (codigo == null) JSONObject.NULL else estado[codigo] == true)
    }

    private fun guardarNombres(dispositivos: JSONArray) {
        val nombres = JSONObject()
        for (i in 0 until dispositivos.length()) dispositivos.getJSONObject(i).let { nombres.put(it.getString("id"), it.getString("nombre")) }
        guardar("nombres", nombres)
    }

    private fun funciones(c: JSONObject, id: String): JSONArray {
        val clave = "funciones:$id"
        obj(clave)?.let { if (ahora() - it.optLong("t") < 6 * HORA) return it.getJSONArray("lista") }
        val r = tuya(c, "GET", "/v1.0/iot-03/devices/${URLEncoder.encode(id, "UTF-8")}/functions") as? JSONObject
        val lista = r?.optJSONArray("functions") ?: JSONArray()
        guardar(clave, JSONObject().put("t", ahora()).put("lista", lista))
        return lista
    }

    private fun comandosPara(funciones: JSONArray, encender: Boolean, brillo: Int?): List<JSONArray> {
        val fs = (0 until funciones.length()).mapNotNull { funciones.optJSONObject(it) }
        val codigos = fs.map { it.optString("code") }
        val interruptor = INTERRUPTORES.firstOrNull { it in codigos }
            ?: fs.firstOrNull { it.optString("type") == "Boolean" && it.optString("code").startsWith("switch") }?.optString("code")
            ?: "switch_led"
        val tandas = mutableListOf(JSONArray().put(JSONObject().put("code", interruptor).put("value", encender)))
        if (encender && brillo != null) {
            fs.firstOrNull { it.optString("code") in BRILLOS }?.let { f ->
                val rango = runCatching { JSONObject(f.optString("values", "{}")) }.getOrDefault(JSONObject())
                val min = rango.optInt("min", 10)
                val max = rango.optInt("max", 1000)
                val pct = brillo.coerceIn(1, 100)
                val extra = JSONArray()
                if ("work_mode" in codigos) extra.put(JSONObject().put("code", "work_mode").put("value", "white"))
                extra.put(JSONObject().put("code", f.optString("code")).put("value", Math.round(min + (max - min) * pct / 100.0).toInt()))
                tandas.add(extra)
            }
        }
        return tandas
    }

    private fun accionar(c: JSONObject, id: String, encender: Boolean, brillo: Int?) {
        val fs = runCatching { funciones(c, id) }.getOrDefault(JSONArray())
        val tandas = comandosPara(fs, encender, brillo)
        val ruta = "/v1.0/iot-03/devices/${URLEncoder.encode(id, "UTF-8")}/commands"
        tuya(c, "POST", ruta, cuerpo = JSONObject().put("commands", tandas[0]))
        for (i in 1 until tandas.size) {
            try {
                tuya(c, "POST", ruta, cuerpo = JSONObject().put("commands", tandas[i]))
            } catch (e: ErrorRutina) {
                anotar(false, "Se encendió, pero no se pudo ajustar el brillo: ${e.message}")
            }
        }
    }

    // -----------------------------------------------------------------------
    // Calendario del móvil
    // -----------------------------------------------------------------------

    private class Evento(
        val id: String, val titulo: String, val todoElDia: Boolean, val inicio: Long,
        val diaInicio: String, val diaFin: String?, val calendario: String,
    )

    private class Calendario(val id: String, val nombre: String, val principal: Boolean)

    private fun formato(patron: String, tz: TimeZone) = SimpleDateFormat(patron, Locale.ROOT).apply { timeZone = tz }

    private fun <T> conPermiso(bloque: () -> T): T = try {
        bloque()
    } catch (e: SecurityException) {
        throw ErrorRutina("La app no tiene permiso para leer tu calendario. Dáselo en Ajustes del móvil → Aplicaciones → Rutina → Permisos.")
    }

    private fun calendarios(): List<Calendario> = conPermiso {
        val lista = mutableListOf<Calendario>()
        val proj = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.IS_PRIMARY)
        ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, proj, null, null, null)?.use { c ->
            while (c.moveToNext()) lista += Calendario(c.getLong(0).toString(), c.getString(1) ?: "Calendario", c.getInt(2) == 1)
        }
        lista
    }

    /** El calendario «principal» es el primero marcado como principal (o el primero que haya). */
    private fun idPrincipal(lista: List<Calendario>) = (lista.firstOrNull { it.principal } ?: lista.firstOrNull())?.id

    private fun eventos(desde: Long, hasta: Long): List<Evento> = conPermiso {
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, desde)
            ContentUris.appendId(it, hasta)
        }.build()
        val proj = arrayOf(
            CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.CALENDAR_ID,
        )
        val utc = TimeZone.getTimeZone("UTC")
        val lista = mutableListOf<Evento>()
        ctx.contentResolver.query(uri, proj, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val todo = c.getInt(4) == 1
                val ini = c.getLong(2)
                val fin = c.getLong(3)
                // Los eventos de día completo se guardan a medianoche UTC.
                lista += Evento(
                    id = c.getLong(0).toString(),
                    titulo = c.getString(1) ?: "",
                    todoElDia = todo,
                    inicio = ini,
                    diaInicio = formato("yyyy-MM-dd", if (todo) utc else zona).format(Date(ini)),
                    diaFin = if (todo) formato("yyyy-MM-dd", utc).format(Date(fin)) else null,
                    calendario = c.getLong(5).toString(),
                )
            }
        }
        lista
    }

    // -----------------------------------------------------------------------
    // Reglas y plan
    // -----------------------------------------------------------------------

    private fun normalizar(s: String) = Normalizer.normalize(s.lowercase(Locale.ROOT), Normalizer.Form.NFD)
        .replace(Regex("\\p{Mn}+"), "").replace(Regex("\\s+"), " ").trim()

    private fun coincide(titulo: String, palabras: String): Boolean {
        val t = normalizar(titulo)
        return palabras.split(",").map { normalizar(it) }.filter { it.isNotEmpty() }.any { t.contains(it) }
    }

    private fun diasEntre(inicio: String, finExclusivo: String?): List<String> {
        val dias = mutableListOf<String>()
        var d = LocalDate.parse(inicio)
        val fin = finExclusivo?.let { LocalDate.parse(it) } ?: d.plusDays(1)
        while (d.isBefore(fin) && dias.size < 31) {
            dias += d.toString()
            d = d.plusDays(1)
        }
        return dias.ifEmpty { listOf(inicio) }
    }

    private fun horaEnMs(dia: String, hora: String) = formato("yyyy-MM-dd HH:mm", zona).parse("$dia $hora")!!.time

    private fun num(o: JSONObject, k: String): Double? = when (val v = o.opt(k)) {
        is Number -> v.toDouble()
        is String -> v.trim().toDoubleOrNull()
        else -> null
    }

    private fun lista(a: JSONArray?) = (0 until (a?.length() ?: 0)).mapNotNull { a!!.optString(it).ifEmpty { null } }

    private fun accionesDeEvento(r: JSONObject, ev: Evento): List<JSONObject> {
        val encender = r.optString("accion") != "apagar"
        val brillo = if (encender) num(r, "brillo")?.toInt() else null
        fun base(clave: String, cuando: Long) = JSONObject()
            .put("clave", clave).put("cuando", cuando)
            .put("regla", r.optString("id")).put("nombreRegla", r.optString("nombre"))
            .put("evento", ev.titulo.take(80))
            .put("dispositivos", r.optJSONArray("dispositivos") ?: JSONArray())
            .put("encender", encender)
            .put("brillo", brillo ?: JSONObject.NULL)

        val acciones = mutableListOf<JSONObject>()
        if (r.optString("modo") == "relativa") {
            if (ev.todoElDia) return acciones
            val antes = (num(r, "minutosAntes") ?: 0.0).toLong()
            acciones += base("${r.optString("id")}|${ev.id}|${ev.inicio}", ev.inicio - antes * MIN)
        } else {
            val dias = if (ev.todoElDia) diasEntre(ev.diaInicio, ev.diaFin) else listOf(ev.diaInicio)
            val hora = r.optString("hora").ifEmpty { "07:00" }
            dias.forEach { dia -> acciones += base("${r.optString("id")}|$dia", horaEnMs(dia, hora)) }
        }
        val apagarTras = (num(r, "apagarTras") ?: 0.0).toLong()
        if (encender && apagarTras > 0) {
            acciones.toList().forEach { a ->
                acciones += JSONObject(a.toString())
                    .put("clave", a.getString("clave") + "|apagar")
                    .put("cuando", a.getLong("cuando") + apagarTras * MIN)
                    .put("encender", false).put("brillo", JSONObject.NULL)
            }
        }
        return acciones
    }

    private fun accionesEntre(reglas: List<JSONObject>, desde: Long, hasta: Long): List<JSONObject> {
        if (reglas.isEmpty()) return emptyList()
        val cals = calendarios()
        val principal = idPrincipal(cals)
        val evs = eventos(desde - DIA, hasta + 2 * DIA)
        val porClave = LinkedHashMap<String, JSONObject>()
        for (r in reglas) {
            val elegidos = lista(r.optJSONArray("calendarios")).ifEmpty { listOf(PRINCIPAL) }
                .map { if (it == PRINCIPAL) principal else it }.toSet()
            evs.filter { it.calendario in elegidos && coincide(it.titulo, r.optString("palabras")) }.forEach { ev ->
                accionesDeEvento(r, ev).forEach { a ->
                    val t = a.getLong("cuando")
                    if (t in desde..hasta && a.getString("clave") !in porClave) porClave[a.getString("clave")] = a
                }
            }
        }
        return porClave.values.sortedBy { it.getLong("cuando") }
    }

    private fun reglas(): List<JSONObject> = arr("reglas").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    fun replanificar(t: Long): JSONArray {
        val activas = reglas().filter { it.optBoolean("activa", true) }
        val acciones = JSONArray()
        accionesEntre(activas, t - MARGEN_RETRASO, t + HORIZONTE_PLAN).take(MAX_ACCIONES_PLAN).forEach { acciones.put(it) }
        guardar("plan", JSONObject().put("hecho", t).put("acciones", acciones))
        return acciones
    }

    private fun accionesDelPlan(): List<JSONObject> =
        obj("plan")?.optJSONArray("acciones")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) } } ?: emptyList()

    /** Lo llama la alarma: vuelve a leer el calendario y ejecuta lo que toque. */
    fun tick(t: Long) {
        try {
            replanificar(t)
        } catch (e: Exception) {
            anotar(false, "No se pudo leer el calendario: ${e.message}")
        }
        ejecutarPendientes(t)
    }

    private fun ejecutarPendientes(t: Long) {
        val pendientes = accionesDelPlan().filter { val c = it.getLong("cuando"); c <= t && c > t - MARGEN_RETRASO }
        if (pendientes.isEmpty()) return
        val hechos = obj("hechos") ?: JSONObject()
        val nombres = obj("nombres") ?: JSONObject()
        var c: JSONObject? = null

        for (a in pendientes) {
            val previo = hechos.optJSONObject(a.getString("clave"))
            if (previo != null && (previo.optBoolean("ok") || previo.optInt("n") >= MAX_INTENTOS)) continue
            val n = (previo?.optInt("n") ?: 0) + 1
            var ok = false
            val ids = lista(a.optJSONArray("dispositivos"))
            val que = (if (a.optBoolean("encender")) "Encender " else "Apagar ") +
                ids.joinToString(", ") { nombres.optString(it, it) } + " («" + a.optString("evento") + "»)"
            try {
                c = c ?: config()
                val errores = mutableListOf<String>()
                val brillo = if (a.isNull("brillo")) null else a.optInt("brillo")
                for (id in ids) {
                    try {
                        accionar(c!!, id, a.optBoolean("encender"), brillo)
                    } catch (e: Exception) {
                        errores += nombres.optString(id, id) + ": " + e.message
                    }
                }
                if (errores.isNotEmpty()) throw ErrorRutina(errores.joinToString(" · "))
                ok = true
                anotar(true, que)
            } catch (e: Exception) {
                anotar(false, "$que → ${e.message}" + if (n < MAX_INTENTOS) " (se reintentará)" else "")
            }
            hechos.put(a.getString("clave"), JSONObject().put("t", t).put("n", n).put("ok", ok))
        }
        hechos.keys().asSequence().toList().forEach { k -> if (hechos.optJSONObject(k)?.optLong("t") ?: 0 < t - 3 * DIA) hechos.remove(k) }
        guardar("hechos", hechos)
    }

    /** Cuándo debe sonar la siguiente alarma: la próxima acción, o dentro de 1 min si hay que reintentar. */
    fun siguienteAlarma(t: Long): Long? {
        val hechos = obj("hechos") ?: JSONObject()
        return accionesDelPlan().mapNotNull { a ->
            val cuando = a.getLong("cuando")
            val previo = hechos.optJSONObject(a.getString("clave"))
            val terminado = previo != null && (previo.optBoolean("ok") || previo.optInt("n") >= MAX_INTENTOS)
            when {
                cuando > t -> cuando
                !terminado && cuando > t - MARGEN_RETRASO -> t + MIN
                else -> null
            }
        }.minOrNull()
    }

    private fun validar(r: JSONObject) {
        val errores = mutableListOf<String>()
        if (r.optString("palabras").isBlank()) errores += "Escribe al menos una palabra del título del evento."
        if (lista(r.optJSONArray("dispositivos")).isEmpty()) errores += "Elige al menos un dispositivo."
        if (r.optString("modo") == "relativa") {
            val m = num(r, "minutosAntes")
            if (m == null || m < 0 || m > 1440) errores += "Los minutos de antelación deben estar entre 0 y 1440."
        } else if (!Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(r.optString("hora"))) {
            errores += "La hora debe tener el formato HH:MM."
        }
        if (!r.isNull("brillo") && r.optString("brillo").isNotEmpty()) {
            val b = num(r, "brillo")
            if (b == null || b < 1 || b > 100) errores += "El brillo debe estar entre 1 y 100."
        }
        if (!r.isNull("apagarTras") && r.optString("apagarTras").isNotEmpty()) {
            val m = num(r, "apagarTras")
            if (m == null || m < 1 || m > 1440) errores += "El apagado automático debe estar entre 1 y 1440 minutos."
        }
        if (errores.isNotEmpty()) throw ErrorRutina(errores.joinToString(" "))
    }

    private fun limpiar(r: JSONObject, idPorDefecto: String? = null): JSONObject {
        val relativa = r.optString("modo") == "relativa"
        val encender = r.optString("accion") != "apagar"
        val palabras = r.optString("palabras").trim()
        val brillo = if (encender) num(r, "brillo")?.toInt() else null
        val apagar = if (encender) num(r, "apagarTras")?.toInt()?.takeIf { it > 0 } else null
        return JSONObject()
            .put("id", r.optString("id").ifEmpty { idPorDefecto ?: UUID.randomUUID().toString().take(8) })
            .put("nombre", r.optString("nombre").trim().ifEmpty { palabras })
            .put("activa", r.optBoolean("activa", true))
            .put("palabras", palabras)
            .put("calendarios", JSONArray(lista(r.optJSONArray("calendarios"))))
            .put("dispositivos", JSONArray(lista(r.optJSONArray("dispositivos"))))
            .put("accion", if (encender) "encender" else "apagar")
            .put("brillo", brillo ?: JSONObject.NULL)
            .put("modo", if (relativa) "relativa" else "fija")
            .put("hora", if (relativa) JSONObject.NULL else r.optString("hora"))
            .put("minutosAntes", if (relativa) (num(r, "minutosAntes") ?: 0.0).toInt() else JSONObject.NULL)
            .put("apagarTras", apagar ?: JSONObject.NULL)
    }

    // -----------------------------------------------------------------------
    // Lo que llama la interfaz (mismos nombres que en la versión web)
    // -----------------------------------------------------------------------

    fun api(nombre: String, a: JSONArray): Any? = when (nombre) {
        "apiEstado" -> estado()
        "apiConectar" -> conectar(a.optString(0), a.optString(1), a.optString(2))
        "apiDesconectar" -> { guardar("config", null); guardar("token", null); true }
        "apiDispositivos" -> listarDispositivos(config()).also { guardarNombres(it) }
        "apiProbar" -> { accionar(config(), a.getString(0), a.optBoolean(1), a.optInt(2, 0).takeIf { it > 0 }); true }
        "apiCalendarios" -> apiCalendarios()
        "apiGuardarRegla" -> {
            val r = a.getJSONObject(0)
            validar(r)
            val limpia = limpiar(r)
            val todas = reglas().toMutableList()
            val i = todas.indexOfFirst { it.optString("id") == limpia.getString("id") }
            if (i >= 0) todas[i] = limpia else todas += limpia
            guardar("reglas", JSONArray(todas))
            cambio()
        }
        "apiActivarRegla" -> {
            guardar("reglas", JSONArray(reglas().onEach { if (it.optString("id") == a.optString(0)) it.put("activa", a.optBoolean(1)) }))
            cambio()
        }
        "apiBorrarRegla" -> {
            guardar("reglas", JSONArray(reglas().filter { it.optString("id") != a.optString(0) }))
            cambio()
        }
        "apiVistaPrevia" -> {
            val r = a.getJSONObject(0)
            validar(r)
            val t = ahora()
            JSONArray(accionesEntre(listOf(limpiar(r, "prueba")), t, t + 14 * DIA).take(12))
        }
        "apiAutomatizacion" -> {
            prefs.edit().putBoolean("automatizacion", a.optBoolean(0)).commit()
            cambio()
        }
        "apiActualizarPlan" -> cambio()
        else -> throw ErrorRutina("Función desconocida: $nombre")
    }

    private fun cambio(): JSONObject {
        try {
            replanificar(ahora())
        } catch (e: ErrorRutina) {
            anotar(false, e.message ?: "Error al leer el calendario")
        }
        Programador.programar(ctx, this)
        return estado()
    }

    private fun estado(): JSONObject {
        val c = obj("config")
        val id = c?.optString("accessId").orEmpty()
        val t = ahora()
        val proximas = JSONArray()
        accionesDelPlan().filter { it.getLong("cuando") > t - MIN }.forEach { proximas.put(it) }
        val regiones = JSONArray()
        REGIONES.forEach { (k, v) -> regiones.put(JSONObject().put("id", k).put("nombre", v.first)) }
        return JSONObject()
            .put("conectado", id.isNotEmpty() && c?.optString("accessSecret").orEmpty().isNotEmpty())
            .put("accessId", if (id.length > 7) id.take(4) + "…" + id.takeLast(3) else "")
            .put("region", c?.optString("region") ?: "eu")
            .put("regiones", regiones)
            .put("automatizacion", automatizacion())
            .put("zona", zona.id)
            .put("reglas", arr("reglas"))
            .put("proximas", proximas)
            .put("planHecho", obj("plan")?.optLong("hecho") ?: JSONObject.NULL)
            .put("registro", arr("registro"))
            .put("nombres", obj("nombres") ?: JSONObject())
    }

    /** Comprueba las claves (probando todas las regiones si hace falta) y las guarda. */
    private fun conectar(accessId: String, accessSecret: String, region: String): JSONArray {
        val id = accessId.trim()
        val secreto = accessSecret.trim()
        if (id.isEmpty() || secreto.isEmpty()) throw ErrorRutina("Rellena el Access ID y el Access Secret.")
        val elegida = if (region in REGIONES) region else "eu"
        var primerError: Exception? = null
        for (r in listOf(elegida) + REGIONES.keys.filter { it != elegida }) {
            val c = JSONObject().put("accessId", id).put("accessSecret", secreto).put("region", r)
            guardar("token", null)
            try {
                val dispositivos = listarDispositivos(c)
                guardar("config", c)
                guardarNombres(dispositivos)
                anotar(true, "Conectado con Tuya (${REGIONES.getValue(r).first}, ${dispositivos.length()} aparatos).")
                Programador.programar(ctx, this)
                return dispositivos
            } catch (e: Exception) {
                if (primerError == null) primerError = e
            }
        }
        throw primerError ?: ErrorRutina("No se pudo conectar con Tuya.")
    }

    private fun apiCalendarios(): JSONArray {
        val cals = calendarios()
        val principal = idPrincipal(cals)
        val salida = JSONArray()
        cals.sortedByDescending { it.id == principal }.forEach {
            salida.put(
                JSONObject()
                    .put("id", if (it.id == principal) PRINCIPAL else it.id)
                    .put("nombre", it.nombre)
                    .put("principal", it.id == principal),
            )
        }
        return salida
    }
}
