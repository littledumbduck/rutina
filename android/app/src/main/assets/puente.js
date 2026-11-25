// Sustituye a google.script.run: las llamadas de la interfaz van a Kotlin (Motor.api).
(function () {
  var pendientes = {};
  var contador = 0;

  window.__respuesta = function (id, ok, valor) {
    var p = pendientes[id];
    delete pendientes[id];
    if (!p) return;
    if (ok) p.ok && p.ok(valor);
    else p.ko && p.ko(new Error(valor));
  };

  function crear(ok, ko) {
    return new Proxy({}, {
      get: function (_, nombre) {
        if (nombre === 'withSuccessHandler') return function (f) { return crear(f, ko); };
        if (nombre === 'withFailureHandler') return function (f) { return crear(ok, f); };
        return function () {
          var id = 'p' + (++contador);
          pendientes[id] = { ok: ok, ko: ko };
          AndroidRutina.llamar(id, String(nombre), JSON.stringify(Array.prototype.slice.call(arguments)));
        };
      },
    });
  }

  window.google = { script: { run: crear() } };
})();
