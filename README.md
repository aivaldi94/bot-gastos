# 💸 Bot de gastos para Telegram + Google Sheets

Bot de Telegram hecho con **Google Apps Script** que anota **gastos e ingresos** en una planilla de Google Sheets. Los movimientos se le mandan **por texto o por nota de voz**, y las notas de voz las interpreta **Gemini**.

- Anota fecha, importe, descripción, categoría y medio de pago (Cash / Virtual).
- Si falta la categoría o el medio de pago, te los **pregunta con botones**.
- Lee las categorías **en vivo** de la planilla: si agregás una, el bot ya la conoce.
- Entiende montos como `1500`, `1.500`, `$23.450`, `1.500,50` y, en audios, también "dos lucas" o "cien lucas".
- **Solo te responde a vos.** Ignora cualquier otro chat y solo acepta pedidos que traigan una clave secreta.
- No hace falta servidor: corre gratis en Apps Script.

---

## 📱 Cómo se usa

| Mensaje al bot | Qué hace |
|---|---|
| `café 1500 comida cash` | Anota un gasto completo |
| `kiosco 800` | Anota el gasto y te pregunta categoría y medio con botones |
| `+ sueldo 850000 virtual` | Anota un **ingreso** (empieza con `+`) |
| `ingreso freelance 200.000` | Anota un ingreso (empieza con `ingreso`, `cobré` o `cobro`) |
| 🎤 *"cobré cien lucas de un trabajo y gasté tres mil en el súper"* | Anota el ingreso y el gasto |
| `/total` | Ingresos, gastos, balance y detalle por categoría y por medio |
| `/borrar` | Borra el último gasto |
| `/borrar ingreso` | Borra el último ingreso |
| `/ayuda` | Muestra la ayuda |

**Medios de pago que reconoce:** `cash`, `efectivo`, `efvo`, `ef` → **Cash** · `virtual`, `debito`, `transferencia`, `transf`, `mp`, `mercadopago`, `qr` → **Virtual**

---

## 🧰 Qué necesitás

- Una cuenta de Google (para Sheets y Apps Script)
- Telegram
- Una API key de Gemini, solo si querés usar notas de voz. Se saca gratis desde Google AI Studio.

---

## 🛠️ Configuración paso a paso

### 1. Crear el bot en Telegram

1. En Telegram, abrí un chat con **[@BotFather](https://t.me/BotFather)**.
2. Mandale `/newbot`.
3. Elegí un **nombre** (por ejemplo, `Mis Gastos`) y un **usuario**, que tiene que terminar en `bot` (por ejemplo, `mis_gastos_123_bot`).
4. BotFather te va a responder con un **token** parecido a `123456789:AAH...`. **Guardalo y no lo compartas**: con ese token cualquiera puede controlar tu bot.

### 2. Preparar la planilla

El bot espera una planilla con dos pestañas, con estos nombres exactos:

**Pestaña `Transacciones`**

- Encabezados en la **fila 3**. Los datos arrancan en la **fila 4**.
- **Gastos** en las columnas **B a F**: `Fecha | Importe | Descripción | Categoría | Como`
- **Ingresos** en las columnas **G a K**: `Fecha | Importe | Descripción | Categoría | Como`

```
     A   B      C        D            E          F     G      H        I            J          K
3        Fecha  Importe  Descripción  Categoría  Como  Fecha  Importe  Descripción  Categoría  Como
4        9      1500     café         Comida     Cash  1      850000   sueldo       Sueldo     Virtual
```

**Pestaña `Resumen`**

- **Categorías de gastos** en `B20:B37`, una por celda (por ejemplo, Comida, Transporte, Servicios...).
- **Categorías de ingresos** en `H20:H37` (por ejemplo, Sueldo, Ahorro, Bonificaciones...).

> 💡 Si tu planilla tiene otra estructura, cambiá las constantes del principio de `Code.gs`: `TX_SHEET`, `RES_SHEET`, `FIRST_ROW` y `TIPOS` (la columna donde empieza cada bloque y el rango de categorías). Con `FECHA_SOLO_DIA = true` en Fecha se anota solo el día del mes. Ponelo en `false` si querés la fecha completa.

### 3. Crear el script dentro de la planilla

El script tiene que estar **vinculado** a la planilla, no puede ser un proyecto suelto.

1. En la planilla, andá a **Extensiones → Apps Script**.
2. Borrá lo que haya en `Código.gs` y pegá el contenido de [`src/Code.gs`](src/Code.gs).
3. *(Opcional)* Para usar el `appsscript.json` del repo, andá a **⚙️ Configuración del proyecto**, tildá **"Mostrar el archivo de manifiesto appsscript.json en el editor"** y reemplazá su contenido por el de [`src/appsscript.json`](src/appsscript.json). Esto deja la zona horaria de Argentina.
4. Guardá (💾 o `Ctrl + S`).

### 4. Revisar que el script vea la planilla

1. En el editor, elegí la función **`probarPlanilla`** en el desplegable de arriba y tocá **▶ Ejecutar**.
2. La primera vez Google te pide **permisos**: **Revisar permisos** → elegí tu cuenta → si aparece *"Google no verificó esta app"*, tocá **Configuración avanzada → Ir a (nombre del proyecto)** → **Permitir**. Es tu propio script, así que es normal que aparezca.
3. En el **Registro de ejecución** fijate que los encabezados, las categorías y la próxima fila libre sean los que esperás. Esta función **no escribe nada**.

### 5. Cargar el token de Telegram

1. Andá a **⚙️ Configuración del proyecto → Propiedades de la secuencia de comandos → Agregar propiedad**.
2. Agregá:

| Propiedad | Valor |
|---|---|
| `TELEGRAM_TOKEN` | El token que te dio BotFather |

3. Tocá **Guardar propiedades de la secuencia de comandos**.

### 6. Publicar el script como aplicación web

1. Arriba a la derecha: **Implementar → Nueva implementación**.
2. En el engranaje ⚙️ de **"Seleccionar tipo"**, elegí **Aplicación web**.
3. Completá:
   - **Ejecutar como:** *Yo*
   - **Quién tiene acceso:** *Cualquier usuario*. Tiene que ser así para que Telegram pueda mandarle los mensajes. Igual, el bot descarta todo lo que no traiga la clave secreta ni venga de tu chat.
4. Tocá **Implementar** y copiá la **URL de la aplicación web**, la que termina en `/exec`.
5. Agregá otra propiedad del script:

| Propiedad | Valor |
|---|---|
| `WEBAPP_URL` | La URL que termina en `/exec` |

### 7. Generar la clave secreta y conectar Telegram

1. Ejecutá la función **`generarSecreto`**. Crea una clave al azar y la guarda sola en `WEBHOOK_SECRET`.
2. Ejecutá la función **`configurarWebhook`**. En el registro tendría que aparecer algo como `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 8. Averiguar tu chat ID y limitar el bot a vos

1. En Telegram, buscá tu bot y mandale `/start`.
2. Como todavía no está cargado `ALLOWED_CHAT_ID`, el bot te responde: **"Tu chat ID es: 12345678"**.
3. Agregá la propiedad:

| Propiedad | Valor |
|---|---|
| `ALLOWED_CHAT_ID` | El número que te mandó el bot |

Desde ese momento el bot **solo te responde a vos**.

### 9. *(Opcional)* Activar las notas de voz con Gemini

1. Entrá a **[Google AI Studio](https://aistudio.google.com/apikey)** y creá una **API key**.
2. Agregá las propiedades:

| Propiedad | Valor |
|---|---|
| `GEMINI_API_KEY` | Tu API key |
| `GEMINI_MODEL` | *(Opcional)* Otro modelo. Si no la cargás, usa el de `GEMINI_MODEL_DEFAULT` |

3. Ejecutá **`probarGemini`**. En el registro tendría que aparecer `Gemini respondió: funciona`.

Si el modelo principal está saturado, el bot prueba solo con los modelos de `GEMINI_MODELOS_RESPALDO`. Los audios pueden durar hasta 120 segundos (`MAX_SEGUNDOS_AUDIO`).

### 10. Probar 🎉

Mandale al bot `café 1500 comida cash` y fijate que aparezca en la planilla. Después probá `/total`.

---

## 🔑 Resumen de propiedades del script

| Propiedad | Obligatoria | Cómo se carga |
|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | A mano, sale de BotFather (paso 1) |
| `WEBAPP_URL` | ✅ | A mano, sale de la implementación (paso 6) |
| `WEBHOOK_SECRET` | ✅ | La genera `generarSecreto` (paso 7) |
| `ALLOWED_CHAT_ID` | ✅ | A mano, te lo dice el bot (paso 8) |
| `GEMINI_API_KEY` | Solo para audios | A mano, sale de AI Studio (paso 9) |
| `GEMINI_MODEL` | ❌ | A mano, opcional |

Para ver cuáles están cargadas sin mostrar los valores, ejecutá **`verPropiedades`**.

---

## 🔄 Si cambiás el código

Después de editar `Code.gs`, **el bot sigue usando la versión anterior** hasta que la publiques:

1. **Implementar → Gestionar implementaciones**.
2. Tocá el lápiz ✏️ de la implementación que ya tenés.
3. En **Versión**, elegí **Nueva versión** → **Implementar**.

Así la URL **no cambia** y no hace falta tocar el webhook. Si en cambio hacés una *nueva implementación*, la URL cambia: actualizá `WEBAPP_URL` y volvé a ejecutar `configurarWebhook`.

## 📅 Si usás una planilla nueva cada mes

El script vive **dentro** de la planilla. Si hacés una copia para el mes nuevo, el webhook de Telegram sigue apuntando a la implementación de la planilla **anterior**. En la copia nueva tenés que:

1. Abrir **Extensiones → Apps Script** y revisar las propiedades con `verPropiedades` (cargá las que falten).
2. Hacer una **nueva implementación** (paso 6) y actualizar `WEBAPP_URL`.
3. Ejecutar **`configurarWebhook`**.

---

## 🩺 Problemas comunes

| Síntoma | Qué revisar |
|---|---|
| El bot no responde nada | Ejecutá `verWebhook`. Si ves `last_error_message`, leé el error. Revisá que `WEBAPP_URL` sea la de `/exec` y volvé a correr `configurarWebhook`. |
| Cambié el código y no se nota | Publicá una **nueva versión** de la implementación (ver "Si cambiás el código"). |
| En los registros aparece "la clave secreta no coincide" | Volviste a generar `WEBHOOK_SECRET`. Ejecutá `configurarWebhook` de nuevo. |
| En los registros aparece "chat ... no coincide con ALLOWED_CHAT_ID" | Revisá que `ALLOWED_CHAT_ID` sea tu número. Para averiguarlo de nuevo, borrá la propiedad y mandale `/start` al bot. |
| "no encuentro la pestaña..." | Los nombres de las pestañas tienen que ser exactamente `Transacciones` y `Resumen`, o cambialos en `TX_SHEET` y `RES_SHEET`. |
| "el script no está vinculado a la planilla" | Creaste el script desde script.google.com. Tiene que crearse desde la planilla con **Extensiones → Apps Script**. |
| Escribe en la fila o columna equivocada | Ejecutá `probarPlanilla` y ajustá `FIRST_ROW` y `TIPOS`. |
| Error con Gemini | Ejecutá `probarGemini`. Revisá `GEMINI_API_KEY`, o cambiá `GEMINI_MODEL` si el modelo ya no existe. |

Los registros de cada mensaje se ven en el editor, en **Ejecuciones** (el ícono ☰▶ de la barra izquierda).

---

## 🔒 Seguridad

- **No hay claves en el código**: el token, la API key, el chat ID y el secreto se guardan en las **propiedades del script**, que no se suben a este repo.
- El webhook solo acepta pedidos que traigan la clave secreta (`WEBHOOK_SECRET`), y el bot solo responde a `ALLOWED_CHAT_ID`.
- `@OnlyCurrentDoc` limita el acceso del script a **esa planilla**, no a todo tu Drive.
- Si alguna vez se filtra el token, regeneralo en BotFather con `/revoke`, actualizá `TELEGRAM_TOKEN` y ejecutá `configurarWebhook`.

---

## 🧪 Funciones para ejecutar a mano desde el editor

| Función | Para qué |
|---|---|
| `probarPlanilla` | Muestra dónde va a escribir (no escribe nada) |
| `verPropiedades` | Muestra qué propiedades están cargadas |
| `generarSecreto` | Genera y guarda `WEBHOOK_SECRET` |
| `configurarWebhook` | Conecta Telegram con la aplicación web |
| `verWebhook` | Muestra el estado del webhook y el último error |
| `probarGemini` | Prueba la API key y el modelo de Gemini |

---

## 💻 *(Opcional)* Trabajar con `clasp`

Si querés editar el código en tu editor y subirlo desde la terminal:

```bash
npm install -g @google/clasp
clasp login
# El ID está en Apps Script → Configuración del proyecto → ID de la secuencia de comandos
clasp clone <ID_DEL_SCRIPT> --rootDir src
clasp push        # sube los cambios de src/ al proyecto
```

`.clasp.json` y `.clasprc.json` están en el `.gitignore` porque tienen el ID del script y tus credenciales.
