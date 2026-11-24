// Simula lo justo de Google Apps Script y de la API de Tuya para probar Codigo.gs con Node.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const firmados = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b)); // Apps Script devuelve bytes con signo

// ---------- fechas con zona horaria ----------
function partesEnZona(ms, zona) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => (p[x.type] = x.value));
  return p;
}
function desfase(ms, zona) {
  const p = partesEnZona(ms, zona);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function localAms(y, m, d, h, mi, zona) {
  const supuesto = Date.UTC(y, m - 1, d, h, mi);
  let ms = supuesto - desfase(supuesto, zona);
  ms = supuesto - desfase(ms, zona);
  return ms;
}

function crearEntorno(opciones) {
  opciones = opciones || {};
  const zona = opciones.zona || 'Europe/Madrid';
  const reloj = { ahora: opciones.ahora || Date.now() };
  const props = new Map();
  const cache = new Map();
  const triggers = [];
  const eventos = opciones.eventos || [];
  const tuya = crearTuyaFalso(reloj);

  class FakeDate extends Date {
    constructor(...a) {
      if (a.length === 0) super(reloj.ahora);
      else super(...a);
    }
    static now() {
      return reloj.ahora;
    }
  }

  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, texto) => firmados(crypto.createHash('sha256').update(texto, 'utf8').digest()),
    computeHmacSha256Signature: (texto, clave) => firmados(crypto.createHmac('sha256', clave).update(texto, 'utf8').digest()),
    getUuid: () => crypto.randomUUID(),
    formatDate: (fecha, z, formato) => {
      const p = partesEnZona(fecha.getTime(), z);
      if (formato === 'yyyy-MM-dd') return p.year + '-' + p.month + '-' + p.day;
      if (formato === 'HH:mm') return p.hour + ':' + p.minute;
      throw new Error('formato no simulado: ' + formato);
    },
    parseDate: (texto, z, formato) => {
      if (formato !== 'yyyy-MM-dd HH:mm') throw new Error('formato no simulado: ' + formato);
      const m = texto.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
      return new Date(localAms(+m[1], +m[2], +m[3], +m[4], +m[5], z));
    },
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => {
        if (String(v).length > 9000) throw new Error('Propiedad demasiado grande: ' + k);
        props.set(k, String(v));
      },
      setProperties: (o) => Object.keys(o).forEach((k) => {
        if (String(o[k]).length > 9000) throw new Error('Propiedad demasiado grande: ' + k);
        props.set(k, String(o[k]));
      }),
      deleteProperty: (k) => props.delete(k),
    }),
  };

  const CacheService = {
    getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => cache.set(k, v),
      remove: (k) => cache.delete(k),
    }),
  };

  // Calendario: los eventos de prueba son { titulo, inicio, fin } (ms) o { titulo, diaCompleto: ['2026-11-25', '2026-11-27'] }
  function eventoFalso(e, i) {
    const todo = !!e.diaCompleto;
    const ini = todo ? localAms(...e.diaCompleto[0].split('-').map(Number), 0, 0, zona) : e.inicio;
    const fin = todo ? localAms(...e.diaCompleto[1].split('-').map(Number), 0, 0, zona) : e.fin;
    return {
      cal: e.calendario || 'principal@ejemplo.com',
      ini, fin,
      getId: () => e.id || 'evento' + i + '@google.com',
      getTitle: () => e.titulo,
      isAllDayEvent: () => todo,
      getStartTime: () => new Date(ini),
      getEndTime: () => new Date(fin),
      getAllDayStartDate: () => new Date(ini),
      getAllDayEndDate: () => new Date(fin),
    };
  }
  const eventosFalsos = eventos.map(eventoFalso);
  function calendario(id, nombre) {
    return {
      getId: () => id,
      getName: () => nombre,
      getTimeZone: () => zona,
      isMyPrimaryCalendar: () => id === 'principal@ejemplo.com',
      getEvents: (desde, hasta) => eventosFalsos.filter((e) => e.cal === id && e.ini < hasta.getTime() && e.fin > desde.getTime()),
    };
  }
  const calendarios = [calendario('principal@ejemplo.com', 'Personal'), calendario('festivos@ejemplo.com', 'Festivos')];
  const CalendarApp = {
    getDefaultCalendar: () => calendarios[0],
    getCalendarById: (id) => calendarios.find((c) => c.getId() === id) || null,
    getAllCalendars: () => calendarios,
  };

  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: (fn) => ({
      timeBased: () => ({
        everyMinutes: (n) => ({
          create: () => {
            const t = { getHandlerFunction: () => fn, minutos: n };
            triggers.push(t);
            return t;
          },
        }),
      }),
    }),
  };

  const contexto = {
    Date: FakeDate,
    Utilities,
    PropertiesService,
    CacheService,
    CalendarApp,
    ScriptApp,
    UrlFetchApp: { fetch: tuya.fetch },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => zona },
    Logger: { log: () => {} },
    HtmlService: {},
    console,
  };
  vm.createContext(contexto);
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Codigo.gs'), 'utf8');
  vm.runInContext(codigo, contexto, { filename: 'Codigo.gs' });

  return { gs: contexto, reloj, props, cache, triggers, tuya, localAms: (y, m, d, h, mi) => localAms(y, m, d, h, mi, zona) };
}

// ---------- Tuya falso: comprueba la firma de cada petición ----------
const ACCESS_ID = 'idprueba123456';
const ACCESS_SECRET = 'secretoprueba7890';

function crearTuyaFalso(reloj) {
  const estado = {
    host: 'openapi.tuyaeu.com',
    peticiones: [],
    comandos: [],
    tokensEmitidos: 0,
    tokenValido: null,
    fallarComandos: false,
    caducarTokenUnaVez: false,
    dispositivos: [
      { id: 'bf01luz', name: 'Tira LED dormitorio', online: true, category: 'dd', product_name: 'LED Strip', status: [{ code: 'switch_led', value: false }] },
      { id: 'bf02enchufe', name: 'Enchufe salón', online: true, category: 'cz', product_name: 'Smart Plug', status: [{ code: 'switch_1', value: true }] },
    ],
    funciones: {
      bf01luz: [
        { code: 'switch_led', type: 'Boolean', values: '{}' },
        { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour","scene","music"]}' },
        { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' },
      ],
      bf02enchufe: [{ code: 'switch_1', type: 'Boolean', values: '{}' }],
    },
  };

  function responder(obj) {
    const texto = JSON.stringify(obj);
    return { getContentText: () => texto, getResponseCode: () => 200 };
  }

  function fetch(url, opciones) {
    const u = new URL(url);
    const h = opciones.headers;
    const metodo = opciones.method.toUpperCase();
    const cuerpo = opciones.payload || '';
    estado.peticiones.push({ metodo, host: u.host, ruta: u.pathname, query: u.search, cuerpo });

    // El proyecto solo existe en su centro de datos.
    if (u.host !== estado.host) return responder({ success: false, code: 1005, msg: 'clientId is invalid' });

    // Firma según la documentación de Tuya (implementación independiente).
    const claves = Array.from(u.searchParams.keys()).sort();
    const rutaFirmada = u.pathname + (claves.length ? '?' + claves.map((k) => k + '=' + u.searchParams.get(k)).join('&') : '');
    const aFirmar = metodo + '\n' + crypto.createHash('sha256').update(cuerpo).digest('hex') + '\n\n' + rutaFirmada;
    const esperado = crypto.createHmac('sha256', ACCESS_SECRET).update(ACCESS_ID + (h.access_token || '') + h.t + aFirmar).digest('hex').toUpperCase();

    if (h.client_id !== ACCESS_ID) return responder({ success: false, code: 1005, msg: 'clientId is invalid' });
    if (h.sign_method !== 'HMAC-SHA256' || h.sign !== esperado) return responder({ success: false, code: 1004, msg: 'sign invalid' });
    if (Math.abs(Number(h.t) - reloj.ahora) > 5 * 60000 && Math.abs(Number(h.t) - Date.now()) > 5 * 60000) {
      return responder({ success: false, code: 1013, msg: 'request time is invalid' });
    }

    if (u.pathname === '/v1.0/token') {
      estado.tokensEmitidos++;
      estado.tokenValido = 'token' + estado.tokensEmitidos;
      return responder({ success: true, result: { access_token: estado.tokenValido, expire_time: 7200, uid: 'x' } });
    }
    if (h.access_token !== estado.tokenValido) return responder({ success: false, code: 1010, msg: 'token invalid' });
    if (estado.caducarTokenUnaVez) {
      estado.caducarTokenUnaVez = false;
      estado.tokenValido = null;
      return responder({ success: false, code: 1010, msg: 'token invalid' });
    }

    if (u.pathname === '/v1.0/iot-01/associated-users/devices' && metodo === 'GET') {
      return responder({ success: true, result: { devices: estado.dispositivos, has_more: false, last_row_key: 'x' } });
    }
    let m = u.pathname.match(/^\/v1\.0\/iot-03\/devices\/([^/]+)\/functions$/);
    if (m) return responder({ success: true, result: { category: 'dd', functions: estado.funciones[m[1]] || [] } });
    m = u.pathname.match(/^\/v1\.0\/iot-03\/devices\/([^/]+)\/commands$/);
    if (m && metodo === 'POST') {
      if (estado.fallarComandos) return responder({ success: false, code: 2001, msg: 'device is offline' });
      estado.comandos.push({ id: m[1], comandos: JSON.parse(cuerpo).commands, t: reloj.ahora });
      return responder({ success: true, result: true });
    }
    return responder({ success: false, code: 1108, msg: 'uri path invalid' });
  }

  estado.fetch = fetch;
  return estado;
}

module.exports = { crearEntorno, ACCESS_ID, ACCESS_SECRET };
