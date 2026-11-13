/**
 * @OnlyCurrentDoc  -> limita el acceso del script a ESTA planilla
 */

/**
 * Bot de Telegram para anotar GASTOS e INGRESOS en la pestaña "Transacciones",
 * por texto o por NOTA DE VOZ. Las notas de voz las interpreta Gemini.
 *
 * Cada tipo ocupa 5 columnas seguidas: Fecha | Importe | Descripción | Categoría | Como
 *   Gastos   -> B:F  (categorías en Resumen!B20:B37)
 *   Ingresos -> G:K  (categorías en Resumen!H20:H37: Ahorro, Sueldo, Bonificaciones...)
 * Las categorías se leen en vivo de Resumen, así que si agregás una, el bot la conoce.
 * En Fecha anota solo el día del mes (9, 10, 21...), igual que venías haciendo a mano.
 *
 * Uso (mensajes al bot):
 *   café 1500 comida cash            -> gasto
 *   kiosco 800                       -> gasto, te pregunta categoría y medio con botones
 *   + sueldo 850000 virtual          -> INGRESO (empieza con "+")
 *   ingreso freelance 200.000        -> INGRESO (empieza con "ingreso" o "cobré")
 *   🎤 "cobré cien lucas de un trabajo y gasté tres mil en el súper"
 *                                    -> anota el ingreso y el gasto
 *
 *   /total           -> ingresos, gastos y balance
 *   /borrar          -> borra el último gasto
 *   /borrar ingreso  -> borra el último ingreso
 *   /ayuda           -> muestra la ayuda
 *
 * Propiedades del script (Configuración del proyecto > Propiedades del script):
 *   TELEGRAM_TOKEN, WEBAPP_URL, ALLOWED_CHAT_ID, WEBHOOK_SECRET, GEMINI_API_KEY, GEMINI_MODEL (opcional)
 *
 * Para chequear dónde va a escribir, ejecutá probarPlanilla desde el editor (no escribe nada).
 */

const TX_SHEET = 'Transacciones';
const RES_SHEET = 'Resumen';
const FIRST_ROW = 4;  // primera fila de datos en Transacciones

// col = columna donde empieza el bloque (B = 2, H = 8, ...)
// catRange = rango de categorías en Resumen ('' = ese tipo no usa categoría)
const TIPOS = {
  g: { nombre: 'gasto', col: 2, catRange: 'B20:B37' },
  i: { nombre: 'ingreso', col: 7, catRange: 'H20:H37' },
};

// true = en Fecha escribe solo el día (como en tu planilla). false = fecha completa dd/mm/yyyy.
const FECHA_SOLO_DIA = true;

// Primera palabra que marca un mensaje como ingreso (sin tildes)
const PALABRAS_INGRESO = ['ingreso', 'ingresos', 'cobre', 'cobro'];

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_MODEL_DEFAULT = 'gemini-3.8-flash';
// Si el principal está saturado (503), prueba estos en orden.
const GEMINI_MODELOS_RESPALDO = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const MAX_SEGUNDOS_AUDIO = 120;

// Palabras que el bot entiende como medio de pago -> valor en la columna "Como"
const MEDIOS = {
  cash: 'Cash', efectivo: 'Cash', efvo: 'Cash', ef: 'Cash',
  virtual: 'Virtual', debito: 'Virtual', transferencia: 'Virtual', transf: 'Virtual',
  mp: 'Virtual', mercadopago: 'Virtual', qr: 'Virtual',
};

const HELP =
  'Gastos:\n' +
  '  café 1500 comida cash\n' +
  '  kiosco 800  (te pregunto categoría y medio)\n\n' +
  'Ingresos (empezá con + o "ingreso"):\n' +
  '  + sueldo 850000 virtual\n' +
  '  ingreso freelance 200.000\n\n' +
  '🎤 O mandame una nota de voz: "cobré cien lucas y gasté tres mil en el súper"\n\n' +
  'Medio: cash/efectivo o virtual/débito/mp (si no lo ponés, te pregunto)\n\n' +
  'Comandos:\n' +
  '  /total – ingresos, gastos y balance\n' +
  '  /borrar – borra el último gasto\n' +
  '  /borrar ingreso – borra el último ingreso\n' +
  '  /ayuda – esta ayuda';

const props = PropertiesService.getScriptProperties();

// ---------- Entrada del webhook ----------

function doPost(e) {
  let chatId = null;
  try {
    // Solo acepta pedidos que traigan la clave secreta (los manda Telegram).
    const secret = props.getProperty('WEBHOOK_SECRET');
    if (!secret || !e || !e.parameter || e.parameter.secret !== secret) {
      console.warn('Descartado: la clave secreta no coincide. Ejecutá configurarWebhook.');
      return ok_();
    }

    const update = JSON.parse(e.postData.contents);

    // Evita procesar dos veces el mismo mensaje si Telegram reintenta.
    const cache = CacheService.getScriptCache();
    const key = 'upd_' + update.update_id;
    if (cache.get(key)) {
      console.log('Descartado: mensaje repetido ' + update.update_id);
      return ok_();
    }
    cache.put(key, '1', 21600);

    const msg = update.message;
    const cb = update.callback_query;
    if (msg && (msg.text || msg.voice || msg.audio)) chatId = String(msg.chat.id);
    else if (cb && cb.message) chatId = String(cb.message.chat.id);
    else return ok_();

    const allowed = props.getProperty('ALLOWED_CHAT_ID');
    if (!allowed) {
      reply_(chatId,
        'Tu chat ID es: ' + chatId + '\n' +
        'Guardalo como ALLOWED_CHAT_ID en las propiedades del script y listo.');
      return ok_();
    }
    if (chatId !== allowed) { // ignora a cualquier otra persona
      console.warn('Descartado: chat ' + chatId + ' no coincide con ALLOWED_CHAT_ID.');
      return ok_();
    }

    if (cb) handleCallback_(chatId, cb);
    else if (msg.voice || msg.audio) handleVoz_(chatId, msg.voice || msg.audio);
    else handle_(chatId, msg.text.trim());
  } catch (err) {
    console.error(err);
    // Si algo falla, avisa por Telegram en vez de quedarse callado.
    if (chatId && chatId === props.getProperty('ALLOWED_CHAT_ID')) {
      reply_(chatId, '⚠️ No pude anotarlo: ' + (err && err.message ? err.message : err));
    }
  }
  return ok_();
}

function handle_(chatId, text) {
  const partes = text.split(/\s+/);
  const cmd = partes[0].toLowerCase().replace(/@.*$/, '');

  if (cmd === '/start' || cmd === '/ayuda') return reply_(chatId, HELP);
  if (cmd === '/total') return reply_(chatId, total_());
  if (cmd === '/borrar') {
    const tipo = partes[1] && PALABRAS_INGRESO.indexOf(norm_(partes[1])) !== -1 ? 'i' : 'g';
    return reply_(chatId, borrar_(tipo));
  }

  // ¿Es un ingreso? "+ sueldo 850000" / "+sueldo 850000" / "ingreso sueldo 850000"
  let tipo = 'g';
  if (text.charAt(0) === '+') {
    tipo = 'i';
    text = text.slice(1).trim();
  } else if (PALABRAS_INGRESO.indexOf(norm_(partes[0])) !== -1) {
    tipo = 'i';
    text = partes.slice(1).join(' ');
  }

  const cats = categorias_(tipo);
  const m = parse_(text, cats);
  if (!m) {
    return reply_(chatId, 'No encontré el monto 🤔 Probá así: café 1500 comida cash  (o + sueldo 850000 para un ingreso)');
  }
  m.tipo = tipo;
  registrar_(chatId, m, cats);
}

// Escribe un movimiento y responde. Si falta la categoría o el medio de pago, los pregunta con botones.
// m = { tipo: 'g'|'i', desc, monto, cat, medio, candidatas }
function registrar_(chatId, m, cats) {
  const row = escribir_(m.tipo, [new Date(), m.monto, m.desc, m.cat || '', m.medio || '']);

  const p = pregunta_(m.tipo, row, cats, m.candidatas);
  if (!p) return reply_(chatId, '✅ Anotado: ' + lineaFila_(m.tipo, row));

  // Queda pendiente: guarda la descripción para verificar la fila cuando toques un botón.
  CacheService.getScriptCache().put('pend_' + m.tipo + row, m.desc, 21600);
  reply_(chatId, p.texto, p.teclado);
}

// Texto de una fila: "café — $1.500 (Cash) · Comida"  /  "💰 Ingreso: sueldo — $850.000 (Virtual)"
function lineaFila_(tipo, row) {
  const v = tx_().getRange(row, TIPOS[tipo].col + 1, 1, 4).getValues()[0]; // Importe, Desc, Cat, Como
  return (tipo === 'i' ? '💰 Ingreso: ' : '') +
    v[1] + ' — $' + fmt_(Number(v[0]) || 0) +
    (v[3] ? ' (' + v[3] + ')' : '') + (v[2] ? ' · ' + v[2] : '');
}

// Devuelve la próxima pregunta para la fila ({texto, teclado}) o null si ya está completa.
function pregunta_(tipo, row, cats, candidatas) {
  const v = tx_().getRange(row, TIPOS[tipo].col + 3, 1, 2).getValues()[0]; // Categoría, Como
  const base = '📝 Anotado: ' + lineaFila_(tipo, row) + '\n';

  if (!v[0] && cats.length) {
    const opciones = candidatas && candidatas.length ? candidatas : cats;
    const botones = opciones.map(function (c) {
      return { text: c, callback_data: 'c|' + tipo + '|' + row + '|' + cats.indexOf(c) };
    });
    const teclado = [];
    for (let k = 0; k < botones.length; k += 2) teclado.push(botones.slice(k, k + 2));
    return { texto: base + '¿Qué categoría?', teclado: { inline_keyboard: teclado } };
  }

  if (!v[1]) {
    return {
      texto: base + (tipo === 'i' ? '¿Cómo te lo pagaron?' : '¿Cómo pagaste?'),
      teclado: { inline_keyboard: [[
        { text: '💵 Cash', callback_data: 'm|' + tipo + '|' + row + '|Cash' },
        { text: '💳 Virtual', callback_data: 'm|' + tipo + '|' + row + '|Virtual' },
      ]] },
    };
  }
  return null;
}

function handleCallback_(chatId, cb) {
  const partes = String(cb.data || '').split('|'); // accion|tipo|fila|valor
  tg_('answerCallbackQuery', { callback_query_id: cb.id });
  if (partes[0] !== 'c' && partes[0] !== 'm') return;

  const vencido = function () {
    return tg_('editMessageText', {
      chat_id: chatId, message_id: cb.message.message_id,
      text: '⚠️ Ese movimiento ya no está pendiente. Completalo a mano en la planilla.',
    });
  };

  const tipo = partes[1];
  if (!TIPOS[tipo]) return vencido(); // botones viejos, de antes de este cambio

  const row = Number(partes[2]);
  const col0 = TIPOS[tipo].col;
  const cats = categorias_(tipo);
  const sh = tx_();
  const cache = CacheService.getScriptCache();
  const desc = cache.get('pend_' + tipo + row);

  let col, valor;
  if (partes[0] === 'c') { col = col0 + 3; valor = cats[Number(partes[3])]; }
  else { col = col0 + 4; valor = partes[3] === 'Cash' || partes[3] === 'Virtual' ? partes[3] : null; }

  // Verifica que la fila siga siendo la misma (por si se borró o se movió algo).
  if (!valor || !desc || sh.getRange(row, col0 + 2).getValue() !== desc) return vencido();

  sh.getRange(row, col).setValue(valor);

  // ¿Falta algo más? Cambia el mismo mensaje por la siguiente pregunta.
  const p = pregunta_(tipo, row, cats);
  if (p) {
    return tg_('editMessageText', {
      chat_id: chatId, message_id: cb.message.message_id,
      text: p.texto, reply_markup: p.teclado,
    });
  }

  cache.remove('pend_' + tipo + row);
  tg_('editMessageText', {
    chat_id: chatId, message_id: cb.message.message_id,
    text: '✅ Anotado: ' + lineaFila_(tipo, row),
  });
}

// ---------- Notas de voz ----------

function handleVoz_(chatId, audio) {
  if (audio.duration && audio.duration > MAX_SEGUNDOS_AUDIO) {
    return reply_(chatId, 'El audio es muy largo 😅 Mandame uno de menos de ' + MAX_SEGUNDOS_AUDIO + ' segundos.');
  }
  tg_('sendChatAction', { chat_id: chatId, action: 'typing' });

  const blob = descargarAudio_(audio.file_id);
  const catsG = categorias_('g');
  const catsI = categorias_('i');
  const r = interpretarAudio_(blob, audio.mime_type || 'audio/ogg', catsG, catsI);

  if (!r.movimientos || !r.movimientos.length) {
    return reply_(chatId, '🤔 No encontré ningún gasto ni ingreso en el audio.' +
      (r.transcripcion ? '\nEntendí: "' + r.transcripcion + '"' : ''));
  }

  if (r.transcripcion) reply_(chatId, '🎧 "' + r.transcripcion + '"');

  r.movimientos.forEach(function (x) {
    const tipo = x.tipo === 'ingreso' ? 'i' : 'g';
    const cats = tipo === 'i' ? catsI : catsG;
    const monto = Number(x.monto);
    if (!monto || monto <= 0) {
      return reply_(chatId, '⚠️ No entendí el monto de "' + (x.descripcion || '?') + '". Mandalo por texto.');
    }
    registrar_(chatId, {
      tipo: tipo,
      desc: String(x.descripcion || 'Sin descripción').trim(),
      monto: monto,
      cat: cats.indexOf(x.categoria) !== -1 ? x.categoria : null,
      medio: x.medio === 'Cash' || x.medio === 'Virtual' ? x.medio : null,
    }, cats);
  });
}

function descargarAudio_(fileId) {
  const token = props.getProperty('TELEGRAM_TOKEN');
  const info = JSON.parse(tg_('getFile', { file_id: fileId }).getContentText());
  if (!info.ok) throw new Error('Telegram no me dio el audio (' + info.description + ').');
  const res = UrlFetchApp.fetch(
    'https://api.telegram.org/file/bot' + token + '/' + info.result.file_path,
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('no pude descargar el audio.');
  return res.getBlob();
}

// Manda el audio a Gemini y devuelve
// { transcripcion, movimientos: [{tipo, descripcion, monto, categoria, medio}] }
function interpretarAudio_(blob, mimeType, catsG, catsI) {
  const prompt =
    'Sos un asistente que anota las finanzas personales de alguien en Argentina (pesos argentinos). ' +
    'Escuchá el audio y extraé TODOS los movimientos de plata que se mencionan.\n' +
    '- tipo: "gasto" si pagó, gastó o compró algo; "ingreso" si cobró, le pagaron, le transfirieron ' +
    'o le entró plata (sueldo, un trabajo, una venta, un reintegro).\n' +
    '- monto: número en pesos. Interpretá expresiones como "mil quinientos" = 1500, ' +
    '"dos lucas" = 2000, "una luca y media" = 1500, "veinte mil" = 20000, "cien lucas" = 100000.\n' +
    '- descripcion: de qué se trata, corto (1 a 4 palabras), sin el monto ni el medio de pago.\n' +
    '- categoria: si es gasto, elegí UNA de esta lista exacta: ' + catsG.join(', ') + '. ' +
    (catsI.length
      ? 'Si es ingreso, elegí UNA de esta lista exacta: ' + catsI.join(', ') + '. '
      : 'Si es ingreso, devolvé "". ') +
    'Las devoluciones de plata que le deben, reintegros, préstamos devueltos y regalos recibidos ' +
    'suelen ir en Bonificaciones. ' +
    'Si no está claro cuál corresponde, devolvé "".\n' +
    '- medio: "Cash" si dice efectivo/cash/plata en mano; "Virtual" si dice débito, transferencia, ' +
    'Mercado Pago, QR, virtual o tarjeta de débito; "" si no lo dice.\n' +
    '- transcripcion: lo que se dijo en el audio, textual.\n' +
    'Si el audio no menciona ningún movimiento de plata, devolvé "movimientos": [].';

  const todasCats = catsG.concat(catsI).filter(function (c, i, arr) { return arr.indexOf(c) === i; });

  const schema = {
    type: 'object',
    properties: {
      transcripcion: { type: 'string' },
      movimientos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['gasto', 'ingreso'] },
            descripcion: { type: 'string' },
            monto: { type: 'number' },
            categoria: { type: 'string', enum: todasCats.concat(['']) },
            medio: { type: 'string', enum: ['Cash', 'Virtual', ''] },
          },
          required: ['tipo', 'descripcion', 'monto', 'categoria', 'medio'],
        },
      },
    },
    required: ['transcripcion', 'movimientos'],
  };

  const texto = gemini_([
    { type: 'text', text: prompt },
    { type: 'audio', data: Utilities.base64Encode(blob.getBytes()), mime_type: mimeType },
  ], schema);

  try {
    return JSON.parse(texto);
  } catch (e) {
    throw new Error('Gemini devolvió algo que no es JSON: ' + texto.slice(0, 200));
  }
}

function gemini_(input, schema) {
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('falta GEMINI_API_KEY en las propiedades del script.');

  // Prueba primero el modelo principal y, si está saturado, los de respaldo.
  const modelos = [props.getProperty('GEMINI_MODEL') || GEMINI_MODEL_DEFAULT]
    .concat(GEMINI_MODELOS_RESPALDO)
    .filter(function (m, i, arr) { return arr.indexOf(m) === i; });

  let ultimoError = '';
  for (let m = 0; m < modelos.length; m++) {
    for (let intento = 0; intento < 2; intento++) {
      const body = { model: modelos[m], input: input };
      if (schema) body.response_format = { type: 'text', mime_type: 'application/json', schema: schema };

      const res = UrlFetchApp.fetch(GEMINI_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': key },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      const raw = res.getContentText();
      if (code === 200) {
        if (m > 0 || intento > 0) console.log('Gemini respondió con ' + modelos[m] + ' (intento ' + (intento + 1) + ')');
        return textoGemini_(JSON.parse(raw));
      }

      console.warn('Gemini ' + modelos[m] + ' ' + code + ': ' + raw);
      let detalle = raw.slice(0, 200);
      try { detalle = JSON.parse(raw).error.message || detalle; } catch (e) {}
      ultimoError = 'Gemini respondió ' + code + ': ' + detalle;

      // Saturado o error temporal: espera y reintenta. Otro error (key, formato): corta.
      if ([429, 500, 503].indexOf(code) === -1) throw new Error(ultimoError);
      if (intento === 0) Utilities.sleep(1500);
    }
  }
  throw new Error(ultimoError + ' (probé ' + modelos.join(', ') + '). Probá de nuevo en un rato o mandalo por texto.');
}

// Saca el texto generado de la respuesta de Gemini.
function textoGemini_(r) {
  let out = '';
  (r.steps || []).forEach(function (s) {
    if (s.type === 'model_output') {
      (s.content || []).forEach(function (c) { if (c.type === 'text' && c.text) out += c.text; });
    }
  });
  if (!out && r.output_text) out = r.output_text;
  // Formato viejo (generateContent), por las dudas.
  if (!out && r.candidates && r.candidates[0] && r.candidates[0].content) {
    (r.candidates[0].content.parts || []).forEach(function (p) { if (p.text) out += p.text; });
  }
  if (!out) throw new Error('Gemini no devolvió texto: ' + JSON.stringify(r).slice(0, 200));
  return out;
}

// ---------- Parseo ----------

function parse_(text, cats) {
  const tokens = text.split(/\s+/).filter(function (t) { return t; });

  // Usa el ÚLTIMO número del mensaje como monto ("2 cafés 3000" -> 3000).
  let i = -1;
  for (let j = tokens.length - 1; j >= 0; j--) {
    if (/^\$?\d[\d.,]*$/.test(tokens[j])) { i = j; break; }
  }
  if (i === -1) return null;

  const monto = parseMonto_(tokens[i]);
  if (isNaN(monto) || monto <= 0) return null;

  const antes = tokens.slice(0, i);
  let medio = null, cat = null, candidatas = null;
  const extra = [];

  // Después del monto: medio de pago y/o categoría, en cualquier orden.
  tokens.slice(i + 1).forEach(function (t) {
    const m = MEDIOS[norm_(t)];
    if (m && !medio) { medio = m; return; }
    // Resto de una categoría de varias palabras ("gastos personales").
    if (cat && palabras_(cat).indexOf(norm_(t)) !== -1) return;
    const c = matchCat_(t, cats);
    if (c.length === 1 && !cat) { cat = c[0]; return; }
    if (c.length > 1 && !cat) candidatas = c;
    extra.push(t);
  });

  // Si no vino categoría después, prueba con las palabras de la descripción ("delivery 9800").
  if (!cat) {
    for (let k = 0; k < antes.length && !cat; k++) {
      const c = matchCat_(antes[k], cats);
      if (c.length === 1) cat = c[0];
      else if (c.length > 1 && !candidatas) candidatas = c;
    }
  }

  const desc = antes.concat(extra).join(' ') || 'Sin descripción';
  return { desc: desc, monto: monto, cat: cat, medio: medio, candidatas: candidatas };
}

function matchCat_(palabra, cats) {
  const w = norm_(palabra);
  if (w.length < 3) return [];
  return cats.filter(function (c) {
    const n = norm_(c);
    return n === w || n.indexOf(w) === 0 || palabras_(c).indexOf(w) !== -1;
  });
}

function palabras_(c) {
  return norm_(c).split(/[\s\/]+/);
}

function parseMonto_(s) {
  s = s.replace('$', '');
  if (s.indexOf(',') !== -1) {
    // 1.500,50 -> 1500.50
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // 1.500 o 23.450 -> miles
    s = s.replace(/\./g, '');
  }
  return parseFloat(s);
}

function norm_(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// ---------- Planilla ----------

function tx_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('el script no está vinculado a la planilla. Crealo desde la planilla con Extensiones → Apps Script.');
  }
  const sh = ss.getSheetByName(TX_SHEET);
  if (!sh) throw new Error('no encuentro la pestaña "' + TX_SHEET + '".');
  return sh;
}

// Categorías del tipo ('g' o 'i'). Devuelve [] si ese tipo no usa categorías.
function categorias_(tipo) {
  const rango = TIPOS[tipo].catRange;
  if (!rango) return [];
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RES_SHEET);
  if (!sh) throw new Error('no encuentro la pestaña "' + RES_SHEET + '".');
  return sh.getRange(rango).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (c) { return c; });
}

// Última fila con algo escrito en cualquiera de las 5 columnas del bloque, o FIRST_ROW - 1 si está vacío.
// (Mira las 5 y no solo Fecha porque hay filas cargadas a mano sin fecha.)
function ultimaFila_(sh, tipo) {
  const n = sh.getMaxRows() - FIRST_ROW + 1;
  if (n <= 0) return FIRST_ROW - 1;
  const vals = sh.getRange(FIRST_ROW, TIPOS[tipo].col, n, 5).getValues();
  for (let k = vals.length - 1; k >= 0; k--) {
    if (vals[k].some(function (v) { return v !== '' && v !== null; })) return FIRST_ROW + k;
  }
  return FIRST_ROW - 1;
}

// Escribe [fecha, importe, descripción, categoría, como] en el bloque del tipo y devuelve la fila.
function escribir_(tipo, valores) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = tx_();
    const col = TIPOS[tipo].col;
    const row = ultimaFila_(sh, tipo) + 1;
    if (row > sh.getMaxRows()) sh.insertRowAfter(sh.getMaxRows());
    if (FECHA_SOLO_DIA && valores[0] instanceof Date) valores[0] = valores[0].getDate();
    sh.getRange(row, col, 1, 5).setValues([valores]);
    if (!FECHA_SOLO_DIA) sh.getRange(row, col).setNumberFormat('dd/mm/yyyy');
    return row;
  } finally {
    lock.releaseLock();
  }
}

// ---------- Comandos ----------

function sumar_(sh, tipo) {
  const res = { total: 0, porCat: {}, porMedio: {} };
  const last = ultimaFila_(sh, tipo);
  if (last < FIRST_ROW) return res;

  const rows = sh.getRange(FIRST_ROW, TIPOS[tipo].col, last - FIRST_ROW + 1, 5).getValues();
  rows.forEach(function (r) {
    const monto = Number(r[1]) || 0;
    if (!monto) return;
    res.total += monto;
    const c = r[3] || 'Sin categoría';
    const m = r[4] || 'Sin medio';
    res.porCat[c] = (res.porCat[c] || 0) + monto;
    res.porMedio[m] = (res.porMedio[m] || 0) + monto;
  });
  return res;
}

function detalle_(titulo, obj) {
  const ks = Object.keys(obj);
  if (!ks.length) return '';
  let s = '\n' + titulo + ':\n';
  ks.sort(function (a, b) { return obj[b] - obj[a]; })
    .forEach(function (k) { s += '  • ' + k + ': $' + fmt_(obj[k]) + '\n'; });
  return s;
}

function total_() {
  const sh = tx_();
  const g = sumar_(sh, 'g');
  const i = sumar_(sh, 'i');
  if (!g.total && !i.total) return 'Todavía no hay nada anotado.';

  let out =
    '💰 Ingresos: $' + fmt_(i.total) + '\n' +
    '💸 Gastos: $' + fmt_(g.total) + '\n' +
    '⚖️ Balance: $' + fmt_(i.total - g.total) + '\n';
  out += detalle_('Gastos por categoría', g.porCat);
  out += detalle_('Gastos por medio', g.porMedio);
  if (TIPOS.i.catRange) out += detalle_('Ingresos por categoría', i.porCat);
  out += detalle_('Ingresos por medio', i.porMedio);
  return out;
}

function borrar_(tipo) {
  const sh = tx_();
  const col = TIPOS[tipo].col;
  const nombre = TIPOS[tipo].nombre;
  const last = ultimaFila_(sh, tipo);
  if (last < FIRST_ROW) return 'No hay ningún ' + nombre + ' para borrar.';

  const r = sh.getRange(last, col, 1, 5).getValues()[0];
  // Limpia solo las 5 columnas del bloque (no borra la fila, así no toca el otro bloque ni el Resumen).
  sh.getRange(last, col, 1, 5).clearContent();
  return '🗑️ Borré el último ' + nombre + ': ' + r[2] + ' — $' + fmt_(Number(r[1]) || 0) +
    (r[3] ? ' (' + r[3] + ')' : '');
}

// ---------- Telegram ----------

function tg_(method, payload) {
  const token = props.getProperty('TELEGRAM_TOKEN');
  return UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function reply_(chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tg_('sendMessage', payload);
}

function fmt_(n) {
  return n.toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

// Respuesta a Telegram. Usa HtmlService porque ContentService responde con una
// redirección (302) que Telegram toma como error: reintenta el mismo mensaje y traba la cola.
function ok_() {
  return HtmlService.createHtmlOutput('ok');
}

// ---------- Configuración y pruebas (se ejecutan a mano desde el editor) ----------

function configurarWebhook() {
  const token = props.getProperty('TELEGRAM_TOKEN');
  const url = props.getProperty('WEBAPP_URL');
  const secret = props.getProperty('WEBHOOK_SECRET');
  const faltan = [];
  if (!token) faltan.push('TELEGRAM_TOKEN');
  if (!url) faltan.push('WEBAPP_URL');
  if (!secret) faltan.push('WEBHOOK_SECRET (ejecutá generarSecreto)');
  if (faltan.length) throw new Error('Faltan estas propiedades: ' + faltan.join(', '));

  const hookUrl = url + '?secret=' + encodeURIComponent(secret);
  const res = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/setWebhook' +
    '?drop_pending_updates=true&url=' + encodeURIComponent(hookUrl));
  console.log(res.getContentText());
}

function verWebhook() {
  const token = props.getProperty('TELEGRAM_TOKEN');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo');
  console.log(res.getContentText());
}

// Prueba desde el editor que el script ve la planilla y muestra dónde va a escribir (no escribe nada).
// Fijate que los encabezados de cada bloque sean los que esperás antes de usar el bot.
function probarPlanilla() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  console.log('Planilla: ' + (ss ? ss.getName() : 'NINGUNA (el script no está vinculado)'));
  const sh = tx_();
  ['g', 'i'].forEach(function (t) {
    const c = TIPOS[t].col;
    const letra = function (n) { return sh.getRange(1, n).getA1Notation().replace(/\d+/, ''); };
    const enc = FIRST_ROW > 1 ? sh.getRange(FIRST_ROW - 1, c, 1, 5).getDisplayValues()[0] : [];
    console.log('--- ' + TIPOS[t].nombre.toUpperCase() + 'S → columnas ' + letra(c) + ':' + letra(c + 4));
    console.log('Encabezados (fila ' + (FIRST_ROW - 1) + '): ' + enc.join(' | '));
    console.log('Categorías: ' + (categorias_(t).join(', ') || '(sin categorías)'));
    console.log('Próxima fila libre: ' + (ultimaFila_(sh, t) + 1));
  });
}

// Genera una clave secreta al azar y la guarda en WEBHOOK_SECRET.
// Ejecutala UNA vez; si la volvés a ejecutar, después corré configurarWebhook.
function generarSecreto() {
  const clave = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('WEBHOOK_SECRET', clave);
  console.log('WEBHOOK_SECRET generada y guardada. Ahora ejecutá configurarWebhook.');
}

// Prueba desde el editor que la API key y el modelo de Gemini funcionan (sin audio).
function probarGemini() {
  const texto = gemini_([{ type: 'text', text: 'Respondé solo con la palabra: funciona' }]);
  console.log('Gemini respondió: ' + texto);
}

// Muestra qué propiedades están cargadas (sin mostrar los valores secretos).
function verPropiedades() {
  ['TELEGRAM_TOKEN', 'WEBAPP_URL', 'WEBHOOK_SECRET', 'ALLOWED_CHAT_ID', 'GEMINI_API_KEY', 'GEMINI_MODEL']
    .forEach(function (k) {
      const v = props.getProperty(k);
      let muestra = v ? '✅ cargada' : '❌ FALTA';
      if (v && k === 'WEBAPP_URL') muestra += ' → ' + v;
      if (v && k === 'TELEGRAM_TOKEN') muestra += ' (bot ' + v.split(':')[0] + ')';
      console.log(k + ': ' + muestra);
    });
  console.log('Otras: ' + props.getKeys().filter(function (k) {
    return ['TELEGRAM_TOKEN', 'WEBAPP_URL', 'WEBHOOK_SECRET', 'ALLOWED_CHAT_ID', 'GEMINI_API_KEY', 'GEMINI_MODEL'].indexOf(k) === -1;
  }).join(', '));
}