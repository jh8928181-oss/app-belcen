const { analizarDocumentoConGemini, resetState, _state } = require('../services/geminiService');

const RESPUESTA_OK = {
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: '{"numero_guia":"F001-123","items":[]}' }] } }] }),
  text: async () => ''
};

/** Construye una respuesta fetch falsa con el JSON indicado. */
function respuestaCon(texto) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: texto }] } }] }),
    text: async () => ''
  };
}

describe('analizarDocumentoConGemini', () => {
  const buffer = Buffer.from('contenido del documento');
  const claveOriginal = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    resetState();
    global.fetch = jest.fn().mockResolvedValue(RESPUESTA_OK);
  });

  afterEach(() => {
    delete global.fetch;
    if (claveOriginal === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = claveOriginal;
    }
  });

  test('devuelve null si no hay API key configurada', async () => {
    delete process.env.GEMINI_API_KEY;
    const resultado = await analizarDocumentoConGemini(buffer, 'image/png', 'texto');
    expect(resultado).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('devuelve null si el mime type no es imagen ni PDF', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    const resultado = await analizarDocumentoConGemini(buffer, 'text/plain', 'texto');
    expect(resultado).toBeNull();
  });

  test('devuelve null cuando el circuit breaker está abierto', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    _state.lastFailureTime = Date.now();
    const resultado = await analizarDocumentoConGemini(buffer, 'image/png', 'texto');
    expect(resultado).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('extrae el JSON de la respuesta de Gemini', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    const resultado = await analizarDocumentoConGemini(buffer, 'image/png', 'texto');
    expect(resultado).toEqual({ numero_guia: 'F001-123', items: [] });
  });

  test('limpia las vallas de markdown ```json', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    global.fetch = jest.fn().mockResolvedValue(
      respuestaCon('```json\n{"tipo_documento":"factura"}\n```')
    );
    const resultado = await analizarDocumentoConGemini(buffer, 'image/png', 'texto');
    expect(resultado).toEqual({ tipo_documento: 'factura' });
  });

  test('usa solo el texto cuando el PDF ya tiene texto suficiente', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    const textoLargo = 'a'.repeat(80);
    await analizarDocumentoConGemini(buffer, 'application/pdf', textoLargo);

    const cuerpo = JSON.parse(global.fetch.mock.calls[0][1].body);
    const partes = cuerpo.contents[0].parts;
    // Solo texto: ninguna imagen embebida.
    expect(partes.some((p) => p.inlineData)).toBe(false);
  });

  test('incluye la imagen cuando el OCR no extrajo texto suficiente', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    await analizarDocumentoConGemini(buffer, 'image/png', 'poco');

    const cuerpo = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(cuerpo.contents[0].parts.some((p) => p.inlineData)).toBe(true);
  });

  test('propaga el error cuando todos los modelos fallan', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    global.fetch = jest.fn().mockRejectedValue(new Error('sin red'));

    await expect(analizarDocumentoConGemini(buffer, 'image/png', 'texto')).rejects.toThrow();
  });

  test('propaga el error si Gemini devuelve un JSON inválido', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    global.fetch = jest.fn().mockResolvedValue(respuestaCon('esto no es json'));

    await expect(analizarDocumentoConGemini(buffer, 'image/png', 'texto')).rejects.toThrow(SyntaxError);
  });

  test('respeta el tamaño máximo del PDF', async () => {
    process.env.GEMINI_API_KEY = 'clave-de-prueba';
    const pdfGrande = Buffer.alloc(9 * 1024 * 1024, 1);
    const resultado = await analizarDocumentoConGemini(pdfGrande, 'application/pdf', 'corto');
    expect(resultado).toBeNull();
  });
});

describe('resetState', () => {
  test('limpia el modelo exitoso y la hora del último fallo', () => {
    _state.lastSuccessfulModel = 'gemini-3.5-flash';
    _state.lastFailureTime = Date.now();

    resetState();

    expect(_state.lastSuccessfulModel).toBe('');
    expect(_state.lastFailureTime).toBe(0);
  });
});
