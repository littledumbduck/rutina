/**
 * Rutina: enciende tus dispositivos Tuya Smart según los eventos de tu Google Calendar.
 *
 * Funciona entero en Google Apps Script (gratis, en la nube):
 *  - Un activador revisa cada minuto si toca ejecutar alguna acción.
 *  - Cada pocos minutos se leen los eventos del calendario y se calcula el plan.
 *  - La web (doGet) sirve para conectar Tuya, ver dispositivos y crear reglas.
 *
 * Instalación: ver README.md.
 */

// ---------------------------------------------------------------------------
// Ajustes generales
// ---------------------------------------------------------------------------

const REGIONES_TUYA = {
  eu: { nombre: 'Europa central', url: 'https://openapi.tuyaeu.com' },
  'eu-w': { nombre: 'Europa occidental', url: 'https://openapi-weaz.tuyaeu.com' },
  us: { nombre: 'América (oeste)', url: 'https://openapi.tuyaus.com' },
  'us-e': { nombre: 'América (este)', url: 'https://openapi-ueaz.tuyaus.com' },
  cn: { nombre: 'China', url: 'https://openapi.tuyacn.com' },
  in: { nombre: 'India', url: 'https://openapi.tuyain.com' },
  sg: { nombre: 'Singapur', url: 'https://openapi-sg.iotbing.com' },
};

const CLAVES = {
  config: 'config', // { accessId, accessSecret, region }
  reglas: 'reglas', // [regla]
  plan: 'plan', // { hecho: ms, acciones: [accion] }
  hechos: 'hechos', // { claveAccion: { t, n, ok } }
  registro: 'registro', // [{ t, ok, texto }]
  nombres: 'nombres', // { idDispositivo: nombre }
};

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

const MARGEN_RETRASO = 15 * MINUTO; // si el activador llega tarde, aún se ejecuta hasta 15 min después
const HORIZONTE_PLAN = 26 * HORA; // cuánto hacia delante se planifica
const REPLANIFICAR_CADA = 5 * MINUTO; // cada cuánto se vuelve a leer el calendario
const MAX_INTENTOS = 3;
const MAX_REGISTRO = 40;
const MAX_ACCIONES_PLAN = 40;

const CALENDARIO_PRINCIPAL = 'principal';

// ---------------------------------------------------------------------------
// Instalación y activador
// ---------------------------------------------------------------------------

/**
 * Ejecútala una vez desde el editor (botón ▶ Ejecutar). Pide los permisos
 * necesarios y crea el activador que revisa el plan cada minuto.
 */
function instalar() {
  activarAutomatizacion_(true);
  const zona = zonaHoraria_();
  Logger.log('Listo. Activador creado. Zona horaria del calendario: ' + zona);
}

/** Lo llama el activador cada minuto. */
function tick() {
  const candado = LockService.getScriptLock();
  if (!candado.tryLock(5000)) return;
  try {
    const ahora = Date.now();
    let plan = leer_(CLAVES.plan, null);
    if (!plan || ahora - plan.hecho > REPLANIFICAR_CADA) {
      plan = replanificar_(ahora);
    }
    ejecutarPendientes_(plan.acciones, ahora);
  } finally {
    candado.releaseLock();
  }
}

function activarAutomatizacion_(activar) {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'tick')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  if (activar) {
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  }
  return automatizacionActiva_();
}

function automatizacionActiva_() {
  return ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'tick');
}

// ---------------------------------------------------------------------------
// Almacenamiento (Propiedades del script)
// ---------------------------------------------------------------------------

// Cada propiedad admite unos 9 KB; los valores largos se guardan en trozos.
const TAMANO_TROZO = 2500;

function leer_(clave, porDefecto) {
  const props = PropertiesService.getScriptProperties();
  const valor = props.getProperty(clave);
  if (valor === null || valor === undefined) return porDefecto;
  try {
    const obj = JSON.parse(valor);
    if (obj && obj.__trozos) {
      let texto = '';
      for (let i = 0; i < obj.__trozos; i++) texto += props.getProperty(clave + '#' + i) || '';
      return JSON.parse(texto);
    }
    return obj;
  } catch (e) {
    return porDefecto;
  }
}

function guardar_(clave, valor) {
  const props = PropertiesService.getScriptProperties();
  const texto = JSON.stringify(valor);
  const trozosAntes = trozosDe_(props, clave);
  const datos = {};
  let trozos = 0;
  if (texto.length <= TAMANO_TROZO) {
    datos[clave] = texto;
  } else {
    trozos = Math.ceil(texto.length / TAMANO_TROZO);
    for (let i = 0; i < trozos; i++) datos[clave + '#' + i] = texto.slice(i * TAMANO_TROZO, (i + 1) * TAMANO_TROZO);
    datos[clave] = JSON.stringify({ __trozos: trozos });
  }
  props.setProperties(datos);
  for (let i = trozos; i < trozosAntes; i++) props.deleteProperty(clave + '#' + i);
}

function trozosDe_(props, clave) {
  try {
    const obj = JSON.parse(props.getProperty(clave));
    return (obj && obj.__trozos) || 0;
  } catch (e) {
    return 0;
  }
}

function borrar_(clave) {
  const props = PropertiesService.getScriptProperties();
  const trozos = trozosDe_(props, clave);
  for (let i = 0; i < trozos; i++) props.deleteProperty(clave + '#' + i);
  props.deleteProperty(clave);
}

function anotar_(ok, texto) {
  const registro = leer_(CLAVES.registro, []);
  const entrada = { t: Date.now(), ok: ok, texto: String(texto).slice(0, 300) };
  // Un mismo error repetido (p. ej. el calendario no responde) no llena el historial.
  if (!ok && registro[0] && !registro[0].ok && registro[0].texto === entrada.texto) registro[0].t = entrada.t;
  else registro.unshift(entrada);
  guardar_(CLAVES.registro, registro.slice(0, MAX_REGISTRO));
}

// ---------------------------------------------------------------------------
// Cliente de la API de Tuya
// ---------------------------------------------------------------------------

function configTuya_() {
  const c = leer_(CLAVES.config, null);
  if (!c || !c.accessId || !c.accessSecret) {
    throw new Error('Todavía no has conectado Tuya. Pon tu Access ID y Access Secret.');
  }
  return c;
}

function hex_(bytes) {
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function sha256Hex_(texto) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8));
}

function hmacSha256Hex_(texto, clave) {
  return hex_(Utilities.computeHmacSha256Signature(texto, clave, Utilities.Charset.UTF_8)).toUpperCase();
}

/**
 * Firma de Tuya (algoritmo vigente desde 2021):
 *   stringToSign = MÉTODO \n SHA256(cuerpo) \n (cabeceras firmadas, vacío) \n ruta?query
 *   sign = HMAC-SHA256(accessId + accessToken + t + nonce + stringToSign, secret) en mayúsculas
 */
function firmaTuya_(accessId, accessSecret, token, t, metodo, rutaFirmada, cuerpo) {
  const aFirmar = [metodo, sha256Hex_(cuerpo || ''), '', rutaFirmada].join('\n');
  return hmacSha256Hex_(accessId + (token || '') + t + aFirmar, accessSecret);
}

/**
 * Hace una petición a Tuya y devuelve `result`. Lanza un Error con un
 * mensaje entendible si algo falla.
 */
function tuya_(c, metodo, ruta, query, cuerpoObj, esReintento) {
  const region = REGIONES_TUYA[c.region] || REGIONES_TUYA.eu;
  const esToken = ruta === '/v1.0/token';
  const token = esToken ? '' : tokenTuya_(c);

  const claves = Object.keys(query || {}).sort();
  const qFirma = claves.map((k) => k + '=' + query[k]).join('&');
  const qUrl = claves.map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
  const cuerpo = cuerpoObj ? JSON.stringify(cuerpoObj) : '';
  const t = String(Date.now());

  const cabeceras = {
    client_id: c.accessId,
    sign: firmaTuya_(c.accessId, c.accessSecret, token, t, metodo, ruta + (qFirma ? '?' + qFirma : ''), cuerpo),
    t: t,
    sign_method: 'HMAC-SHA256',
  };
  if (token) cabeceras.access_token = token;

  const opciones = { method: metodo.toLowerCase(), headers: cabeceras, muteHttpExceptions: true };
  if (cuerpo) {
    opciones.payload = cuerpo;
    opciones.contentType = 'application/json';
  }

  const respuesta = UrlFetchApp.fetch(region.url + ruta + (qUrl ? '?' + qUrl : ''), opciones);
  let json;
  try {
    json = JSON.parse(respuesta.getContentText());
  } catch (e) {
    throw new Error('Tuya respondió algo inesperado (HTTP ' + respuesta.getResponseCode() + ').');
  }

  if (!json.success) {
    const tokenCaducado = json.code === 1010 || json.code === 1011 || /token/i.test(json.msg || '');
    if (!esToken && !esReintento && tokenCaducado) {
      CacheService.getScriptCache().remove(claveCacheToken_(c));
      return tuya_(c, metodo, ruta, query, cuerpoObj, true);
    }
    throw new Error(explicarErrorTuya_(json));
  }
  return json.result;
}

function claveCacheToken_(c) {
  return 'tokenTuya:' + c.region + ':' + c.accessId;
}

function tokenTuya_(c) {
  const cache = CacheService.getScriptCache();
  const clave = claveCacheToken_(c);
  const guardado = cache.get(clave);
  if (guardado) return guardado;
  const r = tuya_(c, 'GET', '/v1.0/token', { grant_type: 1 }, null);
  const segundos = Math.max(60, Math.min(21600, (Number(r.expire_time) || 7200) - 300));
  cache.put(clave, r.access_token, segundos);
  return r.access_token;
}

function explicarErrorTuya_(json) {
  const msg = String(json.msg || 'error desconocido');
  let pista = '';
  if (json.code === 1004 || /sign invalid/i.test(msg)) {
    pista = 'Revisa que el Access Secret esté bien copiado.';
  } else if (/client.?id/i.test(msg) || json.code === 1005) {
    pista = 'Revisa el Access ID y que la región sea la del proyecto (Central Europe → "Europa central").';
  } else if (json.code === 1106 || /permission/i.test(msg)) {
    pista =
      'Comprueba que la app Tuya Smart está vinculada al proyecto (Devices → Link App Account) y que el servicio "IoT Core" está activo.';
  } else if (/expire|trial|subscri/i.test(msg)) {
    pista = 'Parece que el periodo gratuito de Tuya ha caducado: renuévalo en platform.tuya.com (Cloud → tu proyecto → Service API).';
  }
  return 'Tuya: ' + msg + ' (código ' + json.code + ')' + (pista ? '. ' + pista : '');
}

// ---------------------------------------------------------------------------
// Dispositivos
// ---------------------------------------------------------------------------

const INTERRUPTORES = ['switch_led', 'switch_1', 'switch', 'led_switch'];
const BRILLOS = ['bright_value_v2', 'bright_value', 'bright_value_1'];

function listarDispositivos_(c) {
  let todos = [];
  let filaSiguiente = null;
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const query = { size: 50 };
    if (filaSiguiente) query.last_row_key = filaSiguiente;
    const r = tuya_(c, 'GET', '/v1.0/iot-01/associated-users/devices', query, null);
    todos = todos.concat(r.devices || []);
    if (!r.has_more || !r.last_row_key) break;
    filaSiguiente = r.last_row_key;
  }
  return todos.map(resumirDispositivo_);
}

function resumirDispositivo_(d) {
  const estado = {};
  (d.status || []).forEach((s) => (estado[s.code] = s.value));
  const codigo = INTERRUPTORES.find((k) => k in estado) || Object.keys(estado).find((k) => /^switch/.test(k) && typeof estado[k] === 'boolean');
  return {
    id: d.id,
    nombre: d.name || d.id,
    online: !!d.online,
    categoria: d.category || '',
    producto: d.product_name || '',
    encendido: codigo ? !!estado[codigo] : null,
  };
}

function funcionesDispositivo_(c, id) {
  const cache = CacheService.getScriptCache();
  const clave = 'funciones:' + id;
  const guardado = cache.get(clave);
  if (guardado) return JSON.parse(guardado);
  const r = tuya_(c, 'GET', '/v1.0/iot-03/devices/' + encodeURIComponent(id) + '/functions', null, null);
  const funciones = (r.functions || []).map((f) => ({ code: f.code, type: f.type, values: f.values }));
  cache.put(clave, JSON.stringify(funciones), 21600);
  return funciones;
}

/** Decide qué comandos enviar a partir de las funciones que anuncia el dispositivo. */
function comandosPara_(funciones, encender, brillo) {
  const codigos = funciones.map((f) => f.code);
  const interruptor =
    INTERRUPTORES.find((k) => codigos.indexOf(k) >= 0) ||
    (funciones.find((f) => f.type === 'Boolean' && /^switch/.test(f.code)) || {}).code ||
    'switch_led';
  const comandos = [[{ code: interruptor, value: !!encender }]];

  if (encender && brillo) {
    const fBrillo = funciones.find((f) => BRILLOS.indexOf(f.code) >= 0);
    if (fBrillo) {
      let rango = { min: 10, max: 1000 };
      try {
        rango = Object.assign(rango, JSON.parse(fBrillo.values || '{}'));
      } catch (e) {
        /* se usa el rango por defecto */
      }
      const pct = Math.max(1, Math.min(100, Number(brillo)));
      const valor = Math.round(rango.min + ((rango.max - rango.min) * pct) / 100);
      const extra = [];
      if (codigos.indexOf('work_mode') >= 0) extra.push({ code: 'work_mode', value: 'white' });
      extra.push({ code: fBrillo.code, value: valor });
      comandos.push(extra);
    }
  }
  return comandos;
}

/**
 * Enciende o apaga un dispositivo. Primero manda el encendido y luego, aparte,
 * el brillo: así, si el brillo falla, la luz al menos se enciende.
 */
function accionarDispositivo_(c, id, encender, brillo) {
  let funciones = [];
  try {
    funciones = funcionesDispositivo_(c, id);
  } catch (e) {
    // Si no se pueden leer las funciones, probamos con el código más habitual.
  }
  const tandas = comandosPara_(funciones, encender, brillo);
  tuya_(c, 'POST', '/v1.0/iot-03/devices/' + encodeURIComponent(id) + '/commands', null, { commands: tandas[0] });
  for (let i = 1; i < tandas.length; i++) {
    try {
      tuya_(c, 'POST', '/v1.0/iot-03/devices/' + encodeURIComponent(id) + '/commands', null, { commands: tandas[i] });
    } catch (e) {
      anotar_(false, 'Se encendió, pero no se pudo ajustar el brillo: ' + e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Calendario y reglas
// ---------------------------------------------------------------------------

/*
 * Una regla:
 * {
 *   id, nombre, activa,
 *   palabras: 'trabajo, oficina',     // basta con que el título contenga una
 *   calendarios: ['principal', ...],  // ids de calendario
 *   dispositivos: ['id1', 'id2'],
 *   accion: 'encender' | 'apagar',
 *   brillo: 1..100 | null,
 *   modo: 'fija' | 'relativa',
 *   hora: '07:00',                    // modo fija: a esa hora el día del evento
 *   minutosAntes: 30,                 // modo relativa: antes de que empiece
 *   apagarTras: 60 | null             // apagar automáticamente N minutos después
 * }
 */

let zonaCache_ = null;
function zonaHoraria_() {
  if (!zonaCache_) {
    try {
      zonaCache_ = CalendarApp.getDefaultCalendar().getTimeZone();
    } catch (e) {
      zonaCache_ = Session.getScriptTimeZone();
    }
  }
  return zonaCache_;
}

function normalizar_(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function coincide_(titulo, palabras) {
  const t = normalizar_(titulo);
  const lista = String(palabras || '')
    .split(',')
    .map(normalizar_)
    .filter(Boolean);
  return lista.some((p) => t.indexOf(p) >= 0);
}

/** 'yyyy-MM-dd' + 1 día, sin depender de zonas horarias. */
function sumarDia_(fecha) {
  const p = fecha.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return d.toISOString().slice(0, 10);
}

/** Días de un evento de día completo (el final es exclusivo). Máximo 31. */
function diasEntre_(inicio, finExclusivo) {
  const dias = [];
  let d = inicio;
  while (d < finExclusivo && dias.length < 31) {
    dias.push(d);
    d = sumarDia_(d);
  }
  return dias.length ? dias : [inicio];
}

function horaEnMs_(fecha, hora, zona) {
  return Utilities.parseDate(fecha + ' ' + hora, zona, 'yyyy-MM-dd HH:mm').getTime();
}

/** Acciones que genera un evento concreto para una regla. */
function accionesDeEvento_(regla, evento, zona) {
  const encender = regla.accion !== 'apagar';
  const base = {
    regla: regla.id,
    nombreRegla: regla.nombre || '',
    evento: String(evento.titulo || '').slice(0, 80),
    dispositivos: regla.dispositivos || [],
    encender: encender,
    brillo: encender && regla.brillo ? Number(regla.brillo) : null,
  };
  const acciones = [];

  if (regla.modo === 'relativa') {
    if (evento.todoElDia) return acciones; // un evento de día completo no tiene hora de inicio
    const cuando = evento.inicio - (Number(regla.minutosAntes) || 0) * MINUTO;
    acciones.push(Object.assign({ clave: regla.id + '|' + evento.id + '|' + evento.inicio, cuando: cuando }, base));
  } else {
    const dias = evento.todoElDia ? diasEntre_(evento.diaInicio, evento.diaFin) : [evento.diaInicio];
    dias.forEach((dia) => {
      acciones.push(Object.assign({ clave: regla.id + '|' + dia, cuando: horaEnMs_(dia, regla.hora || '07:00', zona) }, base));
    });
  }

  const apagarTras = Number(regla.apagarTras) || 0;
  if (encender && apagarTras > 0) {
    acciones.slice().forEach((a) => {
      acciones.push(
        Object.assign({}, a, { clave: a.clave + '|apagar', cuando: a.cuando + apagarTras * MINUTO, encender: false, brillo: null })
      );
    });
  }
  return acciones;
}

/** Convierte un CalendarEvent en un objeto simple. */
function eventoSimple_(ev, zona) {
  const zonaScript = Session.getScriptTimeZone();
  const todoElDia = ev.isAllDayEvent();
  const inicio = ev.getStartTime().getTime();
  return {
    id: ev.getId(),
    titulo: ev.getTitle(),
    todoElDia: todoElDia,
    inicio: inicio,
    diaInicio: todoElDia
      ? Utilities.formatDate(ev.getAllDayStartDate(), zonaScript, 'yyyy-MM-dd')
      : Utilities.formatDate(new Date(inicio), zona, 'yyyy-MM-dd'),
    diaFin: todoElDia ? Utilities.formatDate(ev.getAllDayEndDate(), zonaScript, 'yyyy-MM-dd') : null,
  };
}

function eventosDe_(idCalendario, desde, hasta, cache, zona) {
  const clave = idCalendario + '|' + desde.getTime() + '|' + hasta.getTime();
  if (cache[clave]) return cache[clave];
  const cal = idCalendario === CALENDARIO_PRINCIPAL ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(idCalendario);
  const eventos = cal ? cal.getEvents(desde, hasta).map((ev) => eventoSimple_(ev, zona)) : [];
  cache[clave] = eventos;
  return eventos;
}

/** Todas las acciones de unas reglas cuya hora cae entre `desde` y `hasta` (ms). */
function accionesEntre_(reglas, desde, hasta) {
  const zona = zonaHoraria_();
  // Se piden eventos con un día de margen a cada lado: una regla de hora fija
  // o con minutos de antelación puede caer en un día distinto al del evento.
  const ini = new Date(desde - DIA);
  const fin = new Date(hasta + 2 * DIA);
  const cache = {};
  const porClave = {};

  reglas.forEach((regla) => {
    const calendarios = regla.calendarios && regla.calendarios.length ? regla.calendarios : [CALENDARIO_PRINCIPAL];
    calendarios.forEach((idCal) => {
      let eventos = [];
      try {
        eventos = eventosDe_(idCal, ini, fin, cache, zona);
      } catch (e) {
        anotar_(false, 'No se pudo leer el calendario ' + idCal + ': ' + e.message);
      }
      eventos
        .filter((ev) => coincide_(ev.titulo, regla.palabras))
        .forEach((ev) => {
          accionesDeEvento_(regla, ev, zona).forEach((a) => {
            if (a.cuando >= desde && a.cuando <= hasta && !porClave[a.clave]) porClave[a.clave] = a;
          });
        });
    });
  });

  return Object.keys(porClave)
    .map((k) => porClave[k])
    .sort((a, b) => a.cuando - b.cuando);
}

function replanificar_(ahora) {
  const reglas = leer_(CLAVES.reglas, []).filter((r) => r.activa !== false);
  const acciones = accionesEntre_(reglas, ahora - MARGEN_RETRASO, ahora + HORIZONTE_PLAN).slice(0, MAX_ACCIONES_PLAN);
  const plan = { hecho: ahora, acciones: acciones };
  guardar_(CLAVES.plan, plan);
  return plan;
}

function ejecutarPendientes_(acciones, ahora) {
  const pendientes = acciones.filter((a) => a.cuando <= ahora && a.cuando > ahora - MARGEN_RETRASO);
  if (!pendientes.length) return;

  const hechos = leer_(CLAVES.hechos, {});
  const nombres = leer_(CLAVES.nombres, {});
  let cambios = false;
  let c = null;

  pendientes.forEach((a) => {
    const previo = hechos[a.clave];
    if (previo && (previo.ok || previo.n >= MAX_INTENTOS)) return;
    const intento = { t: ahora, n: (previo ? previo.n : 0) + 1, ok: false };
    const quien = a.dispositivos.map((id) => nombres[id] || id).join(', ');
    const que = (a.encender ? 'Encender' : 'Apagar') + ' ' + quien + ' («' + a.evento + '»)';
    try {
      c = c || configTuya_();
      const errores = [];
      a.dispositivos.forEach((id) => {
        try {
          accionarDispositivo_(c, id, a.encender, a.brillo);
        } catch (e) {
          errores.push((nombres[id] || id) + ': ' + e.message);
        }
      });
      if (errores.length) throw new Error(errores.join(' · '));
      intento.ok = true;
      anotar_(true, que);
    } catch (e) {
      anotar_(false, que + ' → ' + e.message + (intento.n < MAX_INTENTOS ? ' (se reintentará)' : ''));
    }
    hechos[a.clave] = intento;
    cambios = true;
  });

  if (cambios) {
    // Limpia lo que tenga más de 3 días.
    Object.keys(hechos).forEach((k) => {
      if (hechos[k].t < ahora - 3 * DIA) delete hechos[k];
    });
    guardar_(CLAVES.hechos, hechos);
  }
}

function validarRegla_(r) {
  const errores = [];
  if (!String(r.palabras || '').trim()) errores.push('Escribe al menos una palabra del título del evento.');
  if (!r.dispositivos || !r.dispositivos.length) errores.push('Elige al menos un dispositivo.');
  if (r.modo === 'relativa') {
    const m = Number(r.minutosAntes);
    if (!(m >= 0 && m <= 24 * 60)) errores.push('Los minutos de antelación deben estar entre 0 y 1440.');
  } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.hora || ''))) {
    errores.push('La hora debe tener el formato HH:MM.');
  }
  if (r.brillo !== null && r.brillo !== undefined && r.brillo !== '') {
    const b = Number(r.brillo);
    if (!(b >= 1 && b <= 100)) errores.push('El brillo debe estar entre 1 y 100.');
  }
  if (r.apagarTras !== null && r.apagarTras !== undefined && r.apagarTras !== '') {
    const m = Number(r.apagarTras);
    if (!(m >= 1 && m <= 24 * 60)) errores.push('El apagado automático debe estar entre 1 y 1440 minutos.');
  }
  if (errores.length) throw new Error(errores.join(' '));
}

function limpiarRegla_(r) {
  const relativa = r.modo === 'relativa';
  const encender = r.accion !== 'apagar';
  return {
    id: r.id || Utilities.getUuid().slice(0, 8),
    nombre: String(r.nombre || '').trim() || String(r.palabras).trim(),
    activa: r.activa !== false,
    palabras: String(r.palabras || '').trim(),
    calendarios: (r.calendarios || []).filter(Boolean),
    dispositivos: (r.dispositivos || []).filter(Boolean),
    accion: encender ? 'encender' : 'apagar',
    brillo: encender && r.brillo ? Number(r.brillo) : null,
    modo: relativa ? 'relativa' : 'fija',
    hora: relativa ? null : String(r.hora),
    minutosAntes: relativa ? Number(r.minutosAntes) || 0 : null,
    apagarTras: encender && r.apagarTras ? Number(r.apagarTras) : null,
  };
}

// ---------------------------------------------------------------------------
// Web (lo que usa la página del móvil)
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Rutina')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function apiEstado() {
  const c = leer_(CLAVES.config, null);
  const plan = leer_(CLAVES.plan, { acciones: [] });
  const ahora = Date.now();
  return {
    conectado: !!(c && c.accessId && c.accessSecret),
    accessId: c && c.accessId ? c.accessId.slice(0, 4) + '…' + c.accessId.slice(-3) : '',
    region: c ? c.region : 'eu',
    regiones: Object.keys(REGIONES_TUYA).map((k) => ({ id: k, nombre: REGIONES_TUYA[k].nombre })),
    automatizacion: automatizacionActiva_(),
    zona: zonaHoraria_(),
    reglas: leer_(CLAVES.reglas, []),
    proximas: (plan.acciones || []).filter((a) => a.cuando > ahora - MINUTO),
    planHecho: plan.hecho || null,
    registro: leer_(CLAVES.registro, []),
    nombres: leer_(CLAVES.nombres, {}),
  };
}

/**
 * Guarda las claves de Tuya después de comprobar que funcionan. Si no van con
 * la región elegida, prueba las demás (por si el proyecto se creó en otra).
 */
function apiConectar(accessId, accessSecret, region) {
  const base = { accessId: String(accessId || '').trim(), accessSecret: String(accessSecret || '').trim() };
  if (!base.accessId || !base.accessSecret) throw new Error('Rellena el Access ID y el Access Secret.');
  const elegida = REGIONES_TUYA[region] ? region : 'eu';
  const orden = [elegida].concat(Object.keys(REGIONES_TUYA).filter((k) => k !== elegida));

  let primerError = null;
  for (let i = 0; i < orden.length; i++) {
    const c = Object.assign({ region: orden[i] }, base);
    CacheService.getScriptCache().remove(claveCacheToken_(c));
    try {
      const dispositivos = listarDispositivos_(c); // si las claves no valen, lanza el error
      guardar_(CLAVES.config, c);
      guardarNombres_(dispositivos);
      anotar_(true, 'Conectado con Tuya (' + REGIONES_TUYA[c.region].nombre + ', ' + dispositivos.length + ' aparatos).');
      return dispositivos;
    } catch (e) {
      primerError = primerError || e; // el error de la región elegida es el más útil
    }
  }
  throw primerError;
}

function apiDesconectar() {
  borrar_(CLAVES.config);
  return true;
}

function apiDispositivos() {
  const dispositivos = listarDispositivos_(configTuya_());
  guardarNombres_(dispositivos);
  return dispositivos;
}

function guardarNombres_(dispositivos) {
  const nombres = {};
  dispositivos.forEach((d) => (nombres[d.id] = d.nombre));
  guardar_(CLAVES.nombres, nombres);
}

function apiProbar(id, encender, brillo) {
  accionarDispositivo_(configTuya_(), id, !!encender, brillo || null);
  return true;
}

function apiCalendarios() {
  const principal = CalendarApp.getDefaultCalendar().getId();
  return CalendarApp.getAllCalendars().map((cal) => ({
    id: cal.getId() === principal ? CALENDARIO_PRINCIPAL : cal.getId(),
    nombre: cal.getName(),
    principal: cal.getId() === principal,
  }));
}

function apiGuardarRegla(regla) {
  validarRegla_(regla);
  const limpia = limpiarRegla_(regla);
  const reglas = leer_(CLAVES.reglas, []);
  const i = reglas.findIndex((r) => r.id === limpia.id);
  if (i >= 0) reglas[i] = limpia;
  else reglas.push(limpia);
  guardar_(CLAVES.reglas, reglas);
  replanificar_(Date.now());
  return apiEstado();
}

function apiActivarRegla(id, activa) {
  const reglas = leer_(CLAVES.reglas, []);
  reglas.forEach((r) => {
    if (r.id === id) r.activa = !!activa;
  });
  guardar_(CLAVES.reglas, reglas);
  replanificar_(Date.now());
  return apiEstado();
}

function apiBorrarRegla(id) {
  guardar_(
    CLAVES.reglas,
    leer_(CLAVES.reglas, []).filter((r) => r.id !== id)
  );
  replanificar_(Date.now());
  return apiEstado();
}

/** Cuándo se activaría una regla (sin guardarla) en los próximos 14 días. */
function apiVistaPrevia(regla) {
  validarRegla_(regla);
  const limpia = limpiarRegla_(Object.assign({}, regla, { id: regla.id || 'prueba' }));
  const ahora = Date.now();
  return accionesEntre_([limpia], ahora, ahora + 14 * DIA).slice(0, 12);
}

function apiAutomatizacion(activar) {
  activarAutomatizacion_(!!activar);
  if (activar) replanificar_(Date.now());
  return apiEstado();
}

function apiActualizarPlan() {
  replanificar_(Date.now());
  return apiEstado();
}
