# Rutina

Enciende tus luces LED (o cualquier aparato de **Tuya Smart**) según los eventos de tu **Google Calendar**.

> Ejemplo: *si mañana tengo un evento que contiene «trabajo», enciende la tira LED del dormitorio a las 7:00 al 60 % y apágala a los 45 minutos.*

Funciona entero en la nube de Google (Google Apps Script), es gratis y no necesitas dejar nada encendido en casa. Alexa sigue funcionando igual que antes: la app habla directamente con Tuya.

```
Google Calendar ──► Rutina (Apps Script, cada minuto) ──► API de Tuya ──► tus luces
                       ▲
                       └── web en el móvil: aparatos, reglas, próximas acciones e historial
```

## Qué hace

- **Ve tus aparatos** de Tuya Smart y te deja encenderlos y apagarlos para probar.
- **Reglas**: «si hay un evento que contenga *X*, enciende o apaga *estos aparatos*…»
  - **a una hora fija** el día del evento (p. ej. a las 07:00), o
  - **unos minutos antes** de que empiece el evento.
  - Opcional: **brillo** (pone la luz en blanco) y **apagado automático** pasados N minutos.
- Las palabras no distinguen mayúsculas ni tildes y puedes poner varias separadas por comas: `trabajo, oficina`.
- Puedes elegir en qué calendarios buscar.
- Con **Comprobar** ves en qué días y a qué horas se activaría la regla, usando tu calendario real.
- **Historial** con lo que ha hecho y los errores, si los hay.

---

## Instalación (una sola vez, unos 20 minutos)

Hazlo mejor desde un ordenador. Después, la app se usa desde el móvil.

### 1. Crea el proyecto en Tuya

1. Entra en **[platform.tuya.com](https://platform.tuya.com)** y crea una cuenta de desarrollador. Es gratis y es distinta de la cuenta de la app, aunque puedes usar el mismo correo.
   > Si la web sale en chino, busca el selector de idioma arriba a la derecha y elige **English**. En Chrome también puedes usar *Traducir página*, aunque entonces los nombres de los menús no coincidirán con los de esta guía.
2. Ve a **Cloud → Development → Create Cloud Project**:
   - *Project Name*: `rutina`
   - *Industry*: **Smart Home**
   - *Development Method*: **Smart Home**
   - *Data Center*: **Central Europe Data Center**
   - En el paso siguiente, deja marcados los servicios que vienen por defecto (*IoT Core*, *Authorization Token Management*…).
3. Dentro del proyecto, ve a **Devices → Link App Account → Add App Account**. Te saldrá un código QR.
4. En el móvil, abre **Tuya Smart**, ve a **Yo** y toca el icono de escanear (arriba a la derecha). Escanea el QR y confirma. Tus aparatos tienen que aparecer en la pestaña *All Devices* de la web.
   > ⚠️ Vincúlala desde **Devices → Link App Account**, no desde la pestaña *Users*.
5. En **Overview** verás el **Access ID / Client ID** y el **Access Secret / Client Secret**. Los necesitarás en el paso 3. **No los compartas con nadie.**

### 2. Crea el script en Google

1. Ve a **[script.google.com](https://script.google.com)**, pulsa **Nuevo proyecto** y llámalo `Rutina`.
2. En el archivo `Código.gs`, borra todo lo que haya y pega el contenido de [`apps-script/Codigo.gs`](apps-script/Codigo.gs).
3. Pulsa **＋** (junto a *Archivos*), elige **HTML**, llámalo exactamente **`Index`** y pega el contenido de [`apps-script/Index.html`](apps-script/Index.html).
4. Guarda (💾).
5. En la barra de arriba, elige la función **`instalar`** y pulsa **▶ Ejecutar**. Google te pedirá permisos:
   **Revisar permisos** → tu cuenta → *«Google no ha verificado esta aplicación»* → **Configuración avanzada** → **Ir a Rutina (no seguro)** → **Permitir**.
   Es normal: el script lo has creado tú y solo lo usas tú. Necesita permiso para leer tu calendario, conectarse a Tuya y ejecutarse cada minuto.
   > Google describe el permiso del calendario como de «ver y editar», porque no tiene uno más limitado para este tipo de scripts. Rutina **solo lee** eventos; no crea, cambia ni borra nada.
6. Pulsa **Implementar → Nueva implementación**. En el engranaje ⚙️ elige **Aplicación web** y configura:
   - *Ejecutar como*: **Yo**
   - *Quién tiene acceso*: **Solo yo**

   Pulsa **Implementar** y copia la **URL de la aplicación web** (acaba en `/exec`).
7. Abre esa URL en el móvil, con la misma cuenta de Google, y añádela a la pantalla de inicio para tenerla como una app.

### 3. Conecta y crea tu primera regla

1. En **Inicio**, pega el *Access ID* y el *Access Secret*, deja la región en **Europa central** y pulsa **Conectar y probar**. Si la región no es la buena, la app prueba sola las demás y guarda la que funcione. Si no consigues las claves, despliega *¿Dónde consigo estas claves?*.
2. En **Aparatos**, pulsa **Encender** y **Apagar** para comprobar que tus luces responden.
3. En **Reglas**, pulsa **+ Nueva regla**. Por ejemplo:
   - Evento que contenga: `trabajo`
   - Encender: *Tira LED*
   - A una hora fija: `07:00`
   - (opcional) Brillo 60 % y apagar después de 45 minutos
4. Pulsa **Comprobar** para ver cuándo se activaría y después **Guardar**.

En **Inicio → Próximas acciones** verás lo que hay previsto para las próximas 26 horas.

---

## Cosas a tener en cuenta

- **Precisión**: Google revisa el plan cada minuto, así que la luz se enciende dentro del minuto programado.
- **Eventos nuevos**: el calendario se vuelve a leer cada 5 minutos. Si creas un evento muy poco antes de la hora, puede tardar hasta 5 minutos en tenerse en cuenta. Con **Actualizar** se revisa al momento.
- **Retrasos**: si por algún problema de Google la acción llega más de 15 minutos tarde, no se ejecuta, para no encenderte la luz a destiempo.
- **Errores**: si un aparato no responde (por ejemplo, porque está sin conexión), se reintenta hasta 3 veces y se apunta en el historial.
- **Plan gratuito de Tuya**: el servicio *IoT Core* de prueba caduca cada cierto tiempo. Si ves errores de permisos o de suscripción, entra en *platform.tuya.com → Cloud → tu proyecto → Service API* y renuévalo. Es gratis.
- **Brillo**: al ajustar el brillo, la luz se pone en modo blanco.
- **Eventos de día completo**: sirven en el modo «a una hora fija», pero no en el modo «minutos antes», porque no tienen hora de inicio.
- **Claves**: se guardan en las propiedades privadas de tu script de Google y la web nunca las muestra.

## Actualizar a una versión nueva

1. Pega los archivos nuevos en el editor de Apps Script y guarda.
2. Pulsa **Implementar → Gestionar implementaciones → ✏️ Editar**, elige *Versión: Nueva versión* y pulsa **Implementar**. La URL no cambia.

## Desarrollo

Las pruebas simulan Apps Script y la API de Tuya. Para ejecutarlas hace falta Node 18 o posterior y `python3`:

```bash
npm test                      # lógica, firma de Tuya, planificación y activador
node test/captura-ui.js       # capturas de la web a tamaño de móvil (necesita Playwright)
```

Estructura:

| Archivo | Qué es |
|---|---|
| `apps-script/Codigo.gs` | Servidor: cliente de Tuya, lectura del calendario, plan, activador y API de la web |
| `apps-script/Index.html` | La web del móvil |
| `apps-script/appsscript.json` | Manifiesto (opcional: zona horaria y ajustes de la web) |
| `test/` | Pruebas con Node y capturas de la interfaz |
