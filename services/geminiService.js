/**
 * Servicio para interactuar con Gemini AI
 * Maneja reintentos, circuit breaker y selección de modelo de forma encapsulada
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Estado interno encapsulado (no expuesto globalmente)
const state = {
  lastSuccessfulModel: '',
  lastFailureTime: 0,
  FAILURE_COOLDOWN_MS: 10000
};

const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash'];

/**
 * Construye la lista de modelos a probar en orden de preferencia
 */
function getModelList() {
  const models = [];
  if (state.lastSuccessfulModel) models.push(state.lastSuccessfulModel);
  models.push(DEFAULT_MODEL);
  FALLBACK_MODELS.forEach(m => { if (!models.includes(m)) models.push(m); });
  return models.filter(Boolean);
}

/**
 * Verifica si el circuit breaker está activo
 */
function isCircuitOpen() {
  return Date.now() - state.lastFailureTime < state.FAILURE_COOLDOWN_MS;
}

/**
 * Marca un modelo como exitoso
 */
function markSuccess(model) {
  state.lastSuccessfulModel = model;
}

/**
 * Marca un fallo (activa circuit breaker)
 */
function markFailure() {
  state.lastFailureTime = Date.now();
}

/**
 * Resetea el estado (útil para tests)
 */
function resetState() {
  state.lastSuccessfulModel = '';
  state.lastFailureTime = 0;
}

/**
 * Llama a Gemini con un modelo específico
 */
async function llamarGemini(modelo, partes, timeoutMs = 25000) {
  if (!GEMINI_API_KEY || typeof fetch !== 'function') {
    throw new Error('GEMINI_API_KEY no configurada o fetch no disponible');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: partes }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) throw new Error('Respuesta vacía de Gemini');
    return { modelo, txt };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error(`Timeout ${timeoutMs}ms`);
    throw err;
  }
}

/**
 * Ejecuta múltiples llamadas en paralelo y devuelve la primera exitosa
 */
async function primeroExitoso(promesas) {
  return new Promise((resolve, reject) => {
    let primerError = null;
    let pendientes = promesas.length;

    if (pendientes === 0) return reject(new Error('Sin modelos para probar'));

    promesas.forEach(p => {
      Promise.resolve(p).then(
        resolve,
        (e) => {
          if (!primerError) primerError = e;
          if (--pendientes === 0) reject(primerError);
        }
      );
    });
  });
}

/**
 * Función principal para analizar un documento con Gemini
 * Incluye circuit breaker y fallback de modelos
 */
async function analizarDocumentoConGemini(dataBuffer, mimetype, textoExtraido) {
  if (!GEMINI_API_KEY || typeof fetch !== 'function') return null;
  if (isCircuitOpen()) return null;

  const esImagen = mimetype && mimetype.startsWith('image/');
  const esPdf = mimetype === 'application/pdf';
  if (!esImagen && !esPdf) return null;

  const textoOk = textoExtraido && textoExtraido.trim().length >= 60;
  const usarSoloTexto = esPdf && textoOk;
  const demasiadoGrande = (esPdf && dataBuffer.length > 8 * 1024 * 1024) || (!esPdf && dataBuffer.length > 15 * 1024 * 1024);

  let partes;
  if (usarSoloTexto) {
    partes = [
      { text: PROMPT_GEMINI },
      { text: 'DOCUMENTO A ANALIZAR:\n\n' + textoExtraido.trim() }
    ];
  } else {
    if (demasiadoGrande) return null;
    const auxiliares = [];
    if (textoExtraido && textoExtraido.trim().length >= 15) {
      auxiliares.push({ text: 'TEXTO OCR EXTRAÍDO DEL DOCUMENTO (ayuda, no reemplaza la imagen):\n' + textoExtraido.trim() });
    }
    partes = [{ text: PROMPT_GEMINI }].concat(
      auxiliares,
      [{ inlineData: { mimeType: esPdf ? 'application/pdf' : mimetype, data: dataBuffer.toString('base64') } }]
    );
  }

  const modelos = getModelList();

  try {
    const resultado = await primeroExitoso(
      modelos.map(m => llamarGemini(m, partes, usarSoloTexto ? 15000 : 25000))
    );
    markSuccess(resultado.modelo);
    return JSON.parse(resultado.txt.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '').trim());
  } catch (err) {
    markFailure();
    if (err instanceof SyntaxError) console.error('Gemini devolvió un JSON inválido.');
    else console.error('Gemini falló:', err.message);
    throw err;
  }
}

// Prompt para Gemini (extraído del index.js original)
const PROMPT_GEMINI = `Eres un extractor de datos para una empresa de aceites. Analiza el documento (guía de remisión, factura, orden de compra, etc.) y devuelve SOLO un JSON con esta estructura exacta:

{
  "tipo_documento": "guia_remision|factura|orden_compra|otro",
  "numero_guia": "string o null",
  "proveedor": "string o null",
  "chofer": "string o null",
  "dni_chofer": "string o null",
  "placa": "string o null",
  "lugar_partida": "string o null",
  "punto_llegada": "string o null",
  "observaciones": "string o null",
  "items": [
    {
      "producto": "nombre exacto del producto",
      "cantidad": numero,
      "unidad": "unidad de medida",
      "presentacion": "presentación si aplica"
    }
  ],
  "texto_completo": "texto completo extraído del documento"
}

Reglas:
- Si no encuentras un dato, pon null.
- Los items son obligatorios si hay productos en el documento.
- No inventes datos, solo extrae lo que ves.
- Devuelve SOLO el JSON, sin texto adicional, sin markdown.`;

module.exports = {
  analizarDocumentoConGemini,
  resetState, // exportado solo para tests
  _state: state // expuesto solo para debugging/tests
};