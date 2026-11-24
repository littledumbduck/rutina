// Abre Index.html con un google.script.run simulado y saca capturas a tamaño de móvil.
// Uso: node test/captura-ui.js [carpeta_salida] [escala]
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const salida = process.argv[2] || path.join(__dirname, 'capturas');
const escala = Number(process.argv[3] || 1);
fs.mkdirSync(salida, { recursive: true });

function simulacion(conectado) {
  const ahora = Date.now();
  const manana7 = (() => {
    const d = new Date(ahora + 864e5);
    d.setHours(7, 0, 0, 0);
    return d.getTime();
  })();
  const datos = {
    conectado,
    accessId: conectado ? 'a1b2…x9z' : '',
    region: 'eu',
    regiones: [{ id: 'eu', nombre: 'Europa central' }, { id: 'eu-w', nombre: 'Europa occidental' }, { id: 'us', nombre: 'América (oeste)' }],
    automatizacion: conectado,
    zona: 'Europe/Madrid',
    reglas: conectado
      ? [
          { id: 'r1', nombre: 'Despertar para trabajar', activa: true, palabras: 'trabajo', calendarios: ['principal'], dispositivos: ['d1'], accion: 'encender', modo: 'fija', hora: '07:00', brillo: 60, apagarTras: 45 },
          { id: 'r2', nombre: 'Antes del gym', activa: false, palabras: 'gym, gimnasio', calendarios: ['principal'], dispositivos: ['d1', 'd2'], accion: 'encender', modo: 'relativa', minutosAntes: 30, brillo: null, apagarTras: null },
        ]
      : [],
    proximas: conectado
      ? [
          { cuando: manana7, encender: true, brillo: 60, dispositivos: ['d1'], evento: 'Trabajo oficina', nombreRegla: 'Despertar para trabajar' },
          { cuando: manana7 + 45 * 60000, encender: false, brillo: null, dispositivos: ['d1'], evento: 'Trabajo oficina', nombreRegla: 'Despertar para trabajar' },
        ]
      : [],
    registro: conectado
      ? [
          { t: ahora - 3600e3, ok: true, texto: 'Encender Tira LED dormitorio («Trabajo oficina»)' },
          { t: ahora - 90000e3, ok: false, texto: 'Encender Tira LED dormitorio («Trabajo») → Tuya: device is offline (código 2001) (se reintentará)' },
          { t: ahora - 172000e3, ok: true, texto: 'Conectado con Tuya (2 dispositivos).' },
        ]
      : [],
    nombres: { d1: 'Tira LED dormitorio', d2: 'Lámpara salón' },
  };
  return datos;
}

async function main() {
  const navegador = await chromium.launch();
  const errores = [];
  for (const conectado of [true, false]) {
    const pagina = await navegador.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: escala, timezoneId: 'Europe/Madrid', locale: 'es-ES' });
    pagina.on('pageerror', (e) => errores.push(String(e)));
    pagina.on('console', (m) => m.type() === 'error' && errores.push(m.text()));
    await pagina.addInitScript((datos) => {
      const API = {
        apiEstado: () => datos,
        apiDispositivos: () => [
          { id: 'd1', nombre: 'Tira LED dormitorio', online: true, categoria: 'dd', producto: 'LED Strip', encendido: false },
          { id: 'd2', nombre: 'Lámpara salón', online: false, categoria: 'dj', producto: 'Smart Bulb', encendido: null },
        ],
        apiCalendarios: () => [{ id: 'principal', nombre: 'Personal', principal: true }, { id: 'festivos', nombre: 'Festivos en España', principal: false }],
        apiVistaPrevia: () => [
          { cuando: datos.proximas.length ? datos.proximas[0].cuando : Date.now() + 864e5, encender: true, evento: 'Trabajo oficina' },
          { cuando: (datos.proximas.length ? datos.proximas[0].cuando : Date.now()) + 3 * 864e5, encender: true, evento: 'Trabajo (remoto)' },
        ],
        apiProbar: () => true,
        apiAutomatizacion: (a) => Object.assign(datos, { automatizacion: a }),
      };
      const crear = (ok, ko) =>
        new Proxy({}, {
          get(_, nombre) {
            if (nombre === 'withSuccessHandler') return (f) => crear(f, ko);
            if (nombre === 'withFailureHandler') return (f) => crear(ok, f);
            return (...args) => setTimeout(() => {
              try { ok && ok(JSON.parse(JSON.stringify(API[nombre](...args)))); } catch (e) { ko && ko(e); }
            }, 30);
          },
        });
      window.google = { script: { run: crear() } };
    }, simulacion(conectado));

    await pagina.goto('file://' + path.join(__dirname, '..', 'apps-script', 'Index.html'));
    await pagina.waitForSelector('#cargando.oculto', { state: 'attached' });
    await pagina.waitForTimeout(200);
    const pref = conectado ? '' : 'sin-conectar-';
    await pagina.screenshot({ path: path.join(salida, pref + '1-inicio.png'), fullPage: true });

    if (conectado) {
      await pagina.click('[data-pestana=reglas]');
      await pagina.screenshot({ path: path.join(salida, '2-reglas.png'), fullPage: true });
      await pagina.click('[data-editar=r1]');
      await pagina.waitForTimeout(300);
      await pagina.click('#btnVistaPrevia');
      await pagina.waitForTimeout(300);
      await pagina.screenshot({ path: path.join(salida, '3-editor.png') });
      await pagina.evaluate(() => document.querySelector('.cuerpo-dialogo').parentElement.parentElement.scrollTo(0, 99999));
      await pagina.screenshot({ path: path.join(salida, '3b-editor-abajo.png') });
      await pagina.click('#btnCancelarRegla');
      await pagina.click('[data-pestana=dispositivos]');
      await pagina.waitForTimeout(200);
      await pagina.screenshot({ path: path.join(salida, '4-aparatos.png'), fullPage: true });
      await pagina.click('[data-pestana=ajustes]');
      await pagina.screenshot({ path: path.join(salida, '5-ajustes.png'), fullPage: true });
      const anchoScroll = await pagina.evaluate(() => document.documentElement.scrollWidth);
      if (anchoScroll > 390) errores.push('Hay scroll horizontal: ' + anchoScroll + 'px');
    }
    await pagina.close();
  }
  await navegador.close();
  if (errores.length) {
    console.error('ERRORES:\n' + errores.join('\n'));
    process.exit(1);
  }
  console.log('Capturas en ' + salida);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
