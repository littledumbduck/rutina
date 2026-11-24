'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { crearEntorno, ACCESS_ID, ACCESS_SECRET } = require('./entorno');

const plano = (x) => JSON.parse(JSON.stringify(x));
const MIN = 60000;

// "Ahora" = martes 24/11/2026 22:00 en Madrid.
function entornoBase(extra) {
  const tmp = crearEntorno({ eventos: [] });
  const L = tmp.localAms;
  const eventos = [
    { titulo: 'Trabajo oficina', inicio: L(2026, 11, 25, 9, 0), fin: L(2026, 11, 25, 17, 0) },
    { titulo: 'Reunión TRABAJO', inicio: L(2026, 11, 25, 12, 0), fin: L(2026, 11, 25, 13, 0) },
    { titulo: 'Día de GYM', inicio: L(2026, 11, 25, 19, 0), fin: L(2026, 11, 25, 20, 0) },
    { titulo: 'Vacaciones', diaCompleto: ['2026-11-26', '2026-11-28'] },
    { titulo: 'Trabajo en festivo', calendario: 'festivos@ejemplo.com', inicio: L(2026, 11, 27, 10, 0), fin: L(2026, 11, 27, 11, 0) },
  ];
  const env = crearEntorno(Object.assign({ eventos, ahora: L(2026, 11, 24, 22, 0) }, extra));
  return env;
}

function regla(campos) {
  return Object.assign(
    { id: 'r1', nombre: 'Prueba', activa: true, palabras: 'trabajo', calendarios: ['principal'], dispositivos: ['bf01luz'], accion: 'encender', modo: 'fija', hora: '07:00', minutosAntes: null, brillo: null, apagarTras: null },
    campos
  );
}

function conectar(env) {
  return plano(env.gs.apiConectar(ACCESS_ID, ACCESS_SECRET, 'eu'));
}

// ---------------------------------------------------------------------------

test('la firma coincide con la de tinytuya (implementación de referencia en Python)', () => {
  const env = entornoBase();
  const casos = [
    ['', '1700000000000', 'GET', '/v1.0/token?grant_type=1', ''],
    ['tok_abc', '1700000000123', 'GET', '/v1.0/iot-01/associated-users/devices?last_row_key=XyZ&size=50', ''],
    ['tok_abc', '1700000000456', 'POST', '/v1.0/iot-03/devices/bf01luz/commands', '{"commands":[{"code":"switch_led","value":true}]}'],
    ['tok_abc', '1700000000789', 'POST', '/v1.0/iot-03/devices/x/commands', '{"nombre":"Salón ñ 💡"}'],
  ];
  for (const [token, t, metodo, ruta, cuerpo] of casos) {
    const js = env.gs.firmaTuya_(ACCESS_ID, ACCESS_SECRET, token, t, metodo, ruta, cuerpo);
    const py = execFileSync('python3', ['-I', path.join(__dirname, 'firma_referencia.py'), ACCESS_ID, ACCESS_SECRET, token, t, metodo, ruta, cuerpo]).toString().trim();
    assert.equal(js, py, 'firma distinta para ' + metodo + ' ' + ruta);
  }
});

test('las palabras coinciden sin importar mayúsculas ni tildes', () => {
  const { gs } = entornoBase();
  assert.equal(gs.coincide_('Día de GYM', 'gym'), true);
  assert.equal(gs.coincide_('Día de GYM', 'dia'), true);
  assert.equal(gs.coincide_('Reunión', 'reunion'), true);
  assert.equal(gs.coincide_('Reunion', 'REUNIÓN'), true);
  assert.equal(gs.coincide_('Médico', 'trabajo, medico'), true);
  assert.equal(gs.coincide_('Cena', 'trabajo, medico'), false);
  assert.equal(gs.coincide_('Cena', ''), false);
  assert.equal(gs.coincide_('Cena', ' , '), false);
});

test('hora fija: una sola acción por día aunque haya varios eventos que coincidan', () => {
  const env = entornoBase();
  const L = env.localAms;
  const acciones = plano(env.gs.accionesEntre_([regla()], env.reloj.ahora, env.reloj.ahora + 5 * 24 * 60 * MIN));
  assert.equal(acciones.length, 1);
  assert.equal(acciones[0].cuando, L(2026, 11, 25, 7, 0));
  assert.equal(acciones[0].encender, true);
  assert.deepEqual(acciones[0].dispositivos, ['bf01luz']);
});

test('solo mira los calendarios elegidos', () => {
  const env = entornoBase();
  const L = env.localAms;
  const r = regla({ calendarios: ['principal', 'festivos@ejemplo.com'] });
  const acciones = plano(env.gs.accionesEntre_([r], env.reloj.ahora, env.reloj.ahora + 5 * 24 * 60 * MIN));
  assert.deepEqual(acciones.map((a) => a.cuando), [L(2026, 11, 25, 7, 0), L(2026, 11, 27, 7, 0)]);
});

test('modo relativo: N minutos antes del inicio, e ignora eventos de día completo', () => {
  const env = entornoBase();
  const L = env.localAms;
  const gym = plano(env.gs.accionesEntre_([regla({ palabras: 'gym', modo: 'relativa', minutosAntes: 30, hora: null })], env.reloj.ahora, env.reloj.ahora + 3 * 24 * 60 * MIN));
  assert.deepEqual(gym.map((a) => a.cuando), [L(2026, 11, 25, 18, 30)]);

  const vac = plano(env.gs.accionesEntre_([regla({ palabras: 'vacaciones', modo: 'relativa', minutosAntes: 30, hora: null })], env.reloj.ahora, env.reloj.ahora + 5 * 24 * 60 * MIN));
  assert.equal(vac.length, 0);
});

test('eventos de día completo de varios días: una acción cada día', () => {
  const env = entornoBase();
  const L = env.localAms;
  const acciones = plano(env.gs.accionesEntre_([regla({ palabras: 'vacaciones', hora: '08:30' })], env.reloj.ahora, env.reloj.ahora + 5 * 24 * 60 * MIN));
  assert.deepEqual(acciones.map((a) => a.cuando), [L(2026, 11, 26, 8, 30), L(2026, 11, 27, 8, 30)]);
});

test('apagado automático: añade la acción de apagar N minutos después', () => {
  const env = entornoBase();
  const L = env.localAms;
  const acciones = plano(env.gs.accionesEntre_([regla({ apagarTras: 45, brillo: 80 })], env.reloj.ahora, env.reloj.ahora + 2 * 24 * 60 * MIN));
  assert.deepEqual(
    acciones.map((a) => [a.cuando, a.encender, a.brillo]),
    [[L(2026, 11, 25, 7, 0), true, 80], [L(2026, 11, 25, 7, 45), false, null]]
  );
});

test('cambios de hora (horario de verano/invierno) en Madrid', () => {
  const { gs } = entornoBase();
  assert.equal(gs.horaEnMs_('2027-03-28', '07:00', 'Europe/Madrid'), Date.UTC(2027, 2, 28, 5, 0)); // ya en verano (UTC+2)
  assert.equal(gs.horaEnMs_('2026-10-25', '07:00', 'Europe/Madrid'), Date.UTC(2026, 9, 25, 6, 0)); // ya en invierno (UTC+1)
});

test('conectar con claves buenas lista los aparatos; con claves malas explica el error', () => {
  const env = entornoBase();
  const lista = conectar(env);
  assert.deepEqual(lista.map((d) => [d.id, d.nombre, d.encendido]), [['bf01luz', 'Tira LED dormitorio', false], ['bf02enchufe', 'Enchufe salón', true]]);
  assert.equal(plano(env.gs.apiEstado()).conectado, true);

  const env2 = entornoBase();
  assert.throws(() => env2.gs.apiConectar(ACCESS_ID, 'secreto-malo', 'eu'), /Access Secret/);
  assert.throws(() => env2.gs.apiConectar('otro-id', ACCESS_SECRET, 'eu'), /Access ID/);
  assert.equal(plano(env2.gs.apiEstado()).conectado, false);
});

test('si la región elegida no es la del proyecto, prueba las demás y guarda la buena', () => {
  const env = entornoBase();
  const lista = plano(env.gs.apiConectar(ACCESS_ID, ACCESS_SECRET, 'us'));
  assert.equal(lista.length, 2);
  assert.equal(plano(env.gs.apiEstado()).region, 'eu');
  assert.equal(env.tuya.peticiones[0].host, 'openapi.tuyaus.com', 'primero prueba la elegida');

  // Con un proyecto en América, las peticiones posteriores van a América.
  const env2 = entornoBase();
  env2.tuya.host = 'openapi-ueaz.tuyaus.com';
  env2.gs.apiConectar(ACCESS_ID, ACCESS_SECRET, 'eu');
  assert.equal(plano(env2.gs.apiEstado()).region, 'us-e');
  env2.gs.apiProbar('bf01luz', true, null);
  assert.equal(env2.tuya.peticiones.at(-1).host, 'openapi-ueaz.tuyaus.com');
});

test('apiEstado nunca devuelve el secreto', () => {
  const env = entornoBase();
  conectar(env);
  const texto = JSON.stringify(env.gs.apiEstado());
  assert.equal(texto.includes(ACCESS_SECRET), false);
  assert.equal(texto.includes(ACCESS_ID), false);
});

test('flujo completo: el activador enciende a su hora, una sola vez, y luego apaga', () => {
  const env = entornoBase();
  const L = env.localAms;
  conectar(env);
  env.gs.instalar();
  assert.equal(env.triggers.length, 1);
  env.gs.apiGuardarRegla(regla({ id: undefined, apagarTras: 30, brillo: 50 }));

  const tickA = (h, m, s) => {
    env.reloj.ahora = L(2026, 11, 25, h, m) + (s || 0) * 1000;
    env.gs.tick();
  };

  tickA(6, 59, 30);
  assert.equal(env.tuya.comandos.length, 0, 'no debe hacer nada antes de hora');

  tickA(7, 0, 20);
  const encendido = env.tuya.comandos.map((c) => [c.id, c.comandos]);
  assert.deepEqual(encendido, [
    ['bf01luz', [{ code: 'switch_led', value: true }]],
    ['bf01luz', [{ code: 'work_mode', value: 'white' }, { code: 'bright_value_v2', value: 505 }]],
  ]);

  tickA(7, 1, 20);
  tickA(7, 2, 20);
  assert.equal(env.tuya.comandos.length, 2, 'no debe repetir la acción');

  tickA(7, 30, 40);
  assert.deepEqual(env.tuya.comandos.slice(2).map((c) => [c.id, c.comandos]), [['bf01luz', [{ code: 'switch_led', value: false }]]]);

  const registro = plano(env.gs.apiEstado().registro);
  assert.equal(registro[0].ok, true);
  assert.match(registro[0].texto, /Apagar Tira LED dormitorio/);
  assert.match(registro[1].texto, /Encender Tira LED dormitorio .*Trabajo oficina/);
  assert.equal(env.tuya.tokensEmitidos, 1, 'el token se reutiliza');
});

test('si el activador llega con retraso, la acción se ejecuta igual (hasta 15 min)', () => {
  const env = entornoBase();
  const L = env.localAms;
  conectar(env);
  env.gs.apiGuardarRegla(regla({ id: undefined }));
  env.reloj.ahora = L(2026, 11, 25, 7, 12);
  env.gs.tick();
  assert.equal(env.tuya.comandos.length, 1);

  const env2 = entornoBase();
  conectar(env2);
  env2.gs.apiGuardarRegla(regla({ id: undefined }));
  env2.reloj.ahora = L(2026, 11, 25, 7, 20);
  env2.gs.tick();
  assert.equal(env2.tuya.comandos.length, 0, 'demasiado tarde: no se enciende a destiempo');
});

test('si un comando falla se reintenta hasta 3 veces y queda en el historial', () => {
  const env = entornoBase();
  const L = env.localAms;
  conectar(env);
  env.gs.apiGuardarRegla(regla({ id: undefined, dispositivos: ['bf02enchufe'] }));
  env.tuya.fallarComandos = true;
  for (let m = 0; m < 6; m++) {
    env.reloj.ahora = L(2026, 11, 25, 7, m) + 10000;
    env.gs.tick();
  }
  const intentos = env.tuya.peticiones.filter((p) => p.ruta.endsWith('/commands')).length;
  assert.equal(intentos, 3);
  // Los dos avisos «se reintentará» son idénticos y se juntan en uno; el último intento queda aparte.
  const registro = plano(env.gs.apiEstado().registro).filter((r) => !r.ok);
  assert.equal(registro.length, 2);
  assert.match(registro[0].texto, /device is offline/);
  assert.doesNotMatch(registro[0].texto, /se reintentará/);
  assert.match(registro[1].texto, /se reintentará/);
  assert.equal(registro[1].t, L(2026, 11, 25, 7, 1) + 10000, 'el aviso repetido guarda la hora del último intento');
});

test('un mismo error repetido no llena el historial', () => {
  const env = entornoBase();
  env.gs.anotar_(true, 'Conectado');
  env.gs.anotar_(false, 'No se pudo leer el calendario X');
  env.gs.anotar_(false, 'No se pudo leer el calendario X');
  env.gs.anotar_(false, 'No se pudo leer el calendario X');
  env.gs.anotar_(true, 'Encender luz');
  env.gs.anotar_(false, 'No se pudo leer el calendario X');
  assert.deepEqual(plano(env.gs.leer_('registro', [])).map((r) => r.texto), [
    'No se pudo leer el calendario X',
    'Encender luz',
    'No se pudo leer el calendario X',
    'Conectado',
  ]);
});

test('el enchufe usa su propio código de encendido (switch_1)', () => {
  const env = entornoBase();
  conectar(env);
  env.gs.apiProbar('bf02enchufe', true, null);
  assert.deepEqual(plano(env.tuya.comandos[0].comandos), [{ code: 'switch_1', value: true }]);
});

test('si el token caduca, pide uno nuevo y repite la petición', () => {
  const env = entornoBase();
  conectar(env);
  env.tuya.caducarTokenUnaVez = true;
  env.gs.apiProbar('bf01luz', false, null);
  assert.equal(env.tuya.tokensEmitidos, 2);
  assert.deepEqual(plano(env.tuya.comandos.at(-1).comandos), [{ code: 'switch_led', value: false }]);
});

test('reglas: validación y desactivación', () => {
  const env = entornoBase();
  conectar(env);
  assert.throws(() => env.gs.apiGuardarRegla(regla({ palabras: '  ' })), /palabra/);
  assert.throws(() => env.gs.apiGuardarRegla(regla({ dispositivos: [] })), /dispositivo/);
  assert.throws(() => env.gs.apiGuardarRegla(regla({ hora: '7' })), /HH:MM/);
  assert.throws(() => env.gs.apiGuardarRegla(regla({ modo: 'relativa', minutosAntes: -5 })), /minutos/);
  assert.throws(() => env.gs.apiGuardarRegla(regla({ brillo: 150 })), /brillo/);

  let estado = plano(env.gs.apiGuardarRegla(regla({ id: undefined, nombre: '' })));
  assert.equal(estado.reglas.length, 1);
  assert.equal(estado.reglas[0].nombre, 'trabajo');
  assert.equal(estado.proximas.length, 1);

  estado = plano(env.gs.apiActivarRegla(estado.reglas[0].id, false));
  assert.equal(estado.proximas.length, 0);

  estado = plano(env.gs.apiBorrarRegla(estado.reglas[0].id));
  assert.equal(estado.reglas.length, 0);
});

test('vista previa: muestra cuándo se activaría sin guardar nada', () => {
  const env = entornoBase();
  const L = env.localAms;
  const previa = plano(env.gs.apiVistaPrevia(regla({ id: undefined, palabras: 'gym, vacaciones', hora: '06:45' })));
  assert.deepEqual(previa.map((a) => a.cuando), [L(2026, 11, 25, 6, 45), L(2026, 11, 26, 6, 45), L(2026, 11, 27, 6, 45)]);
  assert.equal(plano(env.gs.apiEstado()).reglas.length, 0);
});

test('los valores grandes se guardan en trozos y se limpian', () => {
  const env = entornoBase();
  const grande = Array.from({ length: 400 }, (_, i) => ({ i, texto: 'Encender Tira LED dormitorio («Trabajo oficina ñ»)' }));
  env.gs.guardar_('prueba', grande);
  assert.deepEqual(plano(env.gs.leer_('prueba', null)), grande);
  const trozos = Array.from(env.props.keys()).filter((k) => k.startsWith('prueba#')).length;
  assert.ok(trozos > 1);
  env.gs.guardar_('prueba', [1, 2, 3]);
  assert.deepEqual(plano(env.gs.leer_('prueba', null)), [1, 2, 3]);
  assert.equal(Array.from(env.props.keys()).filter((k) => k.startsWith('prueba#')).length, 0);
});

test('activar y pausar la automatización', () => {
  const env = entornoBase();
  conectar(env);
  assert.equal(plano(env.gs.apiAutomatizacion(true)).automatizacion, true);
  assert.equal(plano(env.gs.apiAutomatizacion(true)).automatizacion, true);
  assert.equal(env.triggers.length, 1, 'no duplica activadores');
  assert.equal(plano(env.gs.apiAutomatizacion(false)).automatizacion, false);
  assert.equal(env.triggers.length, 0);
});
