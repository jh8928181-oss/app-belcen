/**
 * Pruebas de las dos líneas de soplado (automática y manual) con molde.
 *
 * Reglas que se cuidan aqui:
 *  1. Cada reporte guarda línea + molde; la línea conserva el último molde
 *      con el que produjo (GET /api/soplado/lineas).
 *  2. Línea inválida se rechaza con 400 y no mueve nada.
 *  3. Sin la migración, el registro sigue guardándose como antes (sin línea
 *      ni molde) en vez de reventar.
 */
const mockQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (...args) => mockQuery(...args),
    release: (...args) => mockRelease(...args)
  })
}));

jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, authMiddleware: (req, res, next) => next() };
});

const { app } = require('../index');

function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    headersSent: false,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) {
      if (r.statusCode === null) r.statusCode = 200;
      r.cuerpo = cuerpo;
      r.headersSent = true;
      return r;
    }
  };
  return r;
}

function pilaDe(method, ruta) {
  const pila = app.router ? app.router.stack : app._router.stack;
  const mio = ruta.split('/');
  const encaja = (registrado, solicitado) =>
    registrado.startsWith(':') || registrado.toLowerCase() === solicitado.toLowerCase();
  const candidatas = pila.filter(l => {
    if (!l.route || !l.route.methods[method]) return false;
    const suyo = l.route.path.split('/');
    return suyo.length === mio.length && suyo.every((seg, i) => encaja(seg, mio[i]));
  });
  if (!candidatas.length) throw new Error(`No existe la ruta ${method.toUpperCase()} ${ruta}`);
  const literales = candidatas.filter(l => l.route.path.indexOf(':') < 0);
  return (literales.length ? literales : candidatas).pop().route.stack.map(l => l.handle);
}

async function invocar(method, ruta, req = {}) {
  const res = resFalso();
  const peticion = Object.assign(
    { params: {}, body: {}, query: {}, usuario: 'soplado1', rol: 'soplado', headers: {}, method, originalUrl: ruta },
    req
  );
  const capas = pilaDe(method, ruta);
  await new Promise(resolve => {
    let i = 0;
    const siguiente = () => {
      if (i >= capas.length) return resolve();
      const capa = capas[i++];
      const ultima = i >= capas.length;
      Promise.resolve(capa(peticion, res, siguiente)).then(
        () => { if (ultima || res.headersSent) resolve(); },
        () => { if (ultima || res.headersSent) resolve(); }
      );
    };
    siguiente();
  });
  return res;
}

// Mundo programable: columnas, marcha por área, stocks y líneas.
const mundo = {
  columnas: ['linea'],
  marcha: { soplado_automatica: true, soplado_manual: true },
  preforma: 10,
  etiqueta: 10,
  botella: 0,
  blanco: null,
  terminada: null,
  etiquetaArt: null,
  lineas: []
};

function usarMundo() {
  mockQuery.mockImplementation(async (sql, params = []) => {
    const q = String(sql);
    if (/information_schema\.columns/.test(q)) {
      return { rows: mundo.columnas.map(c => ({ column_name: c })) };
    }
    if (/FROM estado_lineas WHERE area/.test(q)) {
      const area = String(params[0] || '');
      if (mundo.marcha[area] === undefined) return { rows: [] };
      return { rows: [{ estado: mundo.marcha[area] ? 'EN MARCHA' : 'PARADO' }] };
    }
    if (/FROM inventario WHERE LOWER\(nombre\) = LOWER\(\$1\)/.test(q)) {
      const nombre = String(params[0] || '').toLowerCase();
      if (nombre.includes('preforma')) return { rows: [{ stock: mundo.preforma }] };
      if (nombre.includes('etiqueta')) return { rows: [{ stock: mundo.etiqueta }] };
      if (nombre.includes('botella')) return { rows: [{ stock: mundo.botella }] };
      return { rows: [] };
    }
    if (/FROM inventario WHERE LOWER\(BTRIM\(nombre\)\)/.test(q)) {
      const nm = String(params[0] || '').toLowerCase();
      if (nm.includes('(blanco)')) return mundo.blanco ? { rows: [{ ...mundo.blanco }] } : { rows: [] };
      if (nm.includes('etiqueta')) return mundo.etiquetaArt ? { rows: [{ ...mundo.etiquetaArt }] } : { rows: [] };
      return mundo.terminada ? { rows: [{ ...mundo.terminada }] } : { rows: [] };
    }
    if (/INSERT INTO inventario \(nombre, categoria, stock/.test(q)) {
      mundo.blanco = { id: 99, stock: 0 };
      return { rows: [{ id: 99, stock: 0 }], rowCount: 1 };
    }
    if (/UPDATE inventario SET stock = stock - \$1 WHERE LOWER\(nombre\)/.test(q)) {
      return { rowCount: 1 };
    }
    if (/UPDATE inventario SET stock = stock \+ \$1 WHERE LOWER\(nombre\)/.test(q)) {
      return { rowCount: 1 };
    }
    if (/FROM soplado_lineas/.test(q)) {
      return { rows: mundo.lineas.map(l => ({ ...l })) };
    }
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mundo.columnas = ['linea'];
  mundo.marcha = { soplado_automatica: true, soplado_manual: true };
  mundo.preforma = 10;
  mundo.etiqueta = 10;
  mundo.botella = 0;
  mundo.blanco = null;
  mundo.terminada = null;
  mundo.etiquetaArt = null;
  mundo.lineas = [
    { linea: 'AUTOMATICA', nombre: 'Línea automática', molde_actual: 'Molde 1 Lt' },
    { linea: 'MANUAL', nombre: 'Línea manual', molde_actual: null }
  ];
  usarMundo();
});

const cuerpoBase = () => ({
  preforma_nombre: 'Preforma X',
  botella_tipo: 'soplado_belini_1lt',
  cantidad_producida: 3000,
  linea: 'MANUAL',
  molde: 'Molde 1 Lt',
  usuario: 'soplado1'
});

describe('POST /api/soplado/registrar', () => {
  test('guarda línea y molde, y memoriza el molde en la línea', async () => {
    const res = await invocar('post', '/api/soplado/registrar', { body: cuerpoBase() });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch(/línea manual/);
    expect(res.cuerpo.mensaje).toMatch(/Molde 1 Lt/);
    const ins = mockQuery.mock.calls.find(c => /INSERT INTO reportes_soplado/.test(String(c[0])));
    expect(ins[1][5]).toBe('MANUAL');
    expect(ins[1][6]).toBe('Molde 1 Lt');
    const mem = mockQuery.mock.calls.find(c => /UPDATE soplado_lineas SET molde_actual/.test(String(c[0])));
    expect(mem[1]).toEqual(['Molde 1 Lt', 'MANUAL']);
  });

  test('al soplar no se descuenta etiqueta ni terminada: van en blanco', async () => {
    const res = await invocar('post', '/api/soplado/registrar', { body: cuerpoBase() });

    expect(res.statusCode).toBe(200);
    const insBlanco = mockQuery.mock.calls.find(c => /INSERT INTO inventario \(nombre, categoria, stock/.test(String(c[0])));
    expect(insBlanco).toBeDefined();
    // El blanco es genérico por tamaño: la marca la pone la etiqueta.
    expect(insBlanco[1][0]).toBe('Botella 1 Lt (blanco)');
    expect(insBlanco[1][1]).toBe('BOTELLAS EN BLANCO');
    const movsEtiqueta = mockQuery.mock.calls.filter(c =>
      /UPDATE inventario SET stock = stock -/.test(String(c[0])) &&
      String(c[1][1] || '').toLowerCase().includes('etiqueta'));
    expect(movsEtiqueta).toHaveLength(0);
  });

  test('el blanco de otra marca del mismo tamaño comparte artículo', async () => {
    // B-1 1 Lt y Belini 1 Lt soplan al mismo blanco genérico.
    const res = await invocar('post', '/api/soplado/registrar', {
      body: { ...cuerpoBase(), botella_tipo: 'soplado_b1_1lt' }
    });

    expect(res.statusCode).toBe(200);
    const insBlanco = mockQuery.mock.calls.find(c => /INSERT INTO inventario \(nombre, categoria, stock/.test(String(c[0])));
    expect(insBlanco[1][0]).toBe('Botella 1 Lt (blanco)');
  });

  test('cada línea exige su propia marcha: manual parada no frena a la automática', async () => {
    mundo.marcha = { soplado_automatica: true, soplado_manual: false };

    const manual = await invocar('post', '/api/soplado/registrar', { body: cuerpoBase() });
    expect(manual.statusCode).toBe(409);
    expect(manual.cuerpo.mensaje).toMatch(/línea manual de soplado está PARADO/i);

    const auto = await invocar('post', '/api/soplado/registrar', {
      body: { ...cuerpoBase(), linea: 'AUTOMATICA' }
    });
    expect(auto.statusCode).toBe(200);
  });

  test('línea inválida se rechaza sin mover nada', async () => {
    const res = await invocar('post', '/api/soplado/registrar', {
      body: { ...cuerpoBase(), linea: 'TURBO' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/Línea inválida/);
    const movs = mockQuery.mock.calls.filter(c => /UPDATE inventario SET stock|INSERT INTO reportes_soplado/.test(String(c[0])));
    expect(movs).toHaveLength(0);
  });

  test('sin la migración se guarda como antes (sin línea ni molde)', async () => {
    mundo.columnas = [];
    const res = await invocar('post', '/api/soplado/registrar', { body: cuerpoBase() });

    expect(res.statusCode).toBe(200);
    const ins = mockQuery.mock.calls.find(c => /INSERT INTO reportes_soplado/.test(String(c[0])));
    expect(String(ins[0])).not.toMatch(/linea/);
  });
});

describe('POST /api/estado-linea', () => {
  test('acepta las dos líneas de soplado por separado', async () => {
    for (const area of ['soplado_automatica', 'soplado_manual']) {
      const res = await invocar('post', '/api/estado-linea', {
        body: { area, estado: 'EN MARCHA', usuario: 'soplado1' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.cuerpo).toMatchObject({ success: true, area, estado: 'EN MARCHA' });
    }
    const mala = await invocar('post', '/api/estado-linea', {
      body: { area: 'soplado_turbo', estado: 'EN MARCHA' }
    });
    expect(mala.statusCode).toBe(400);
  });
});

describe('POST /api/soplado/etiquetar', () => {
  const baseEtq = () => ({ botella_tipo: 'soplado_belini_1lt', cantidad: 2000, linea: 'MANUAL', usuario: 'soplado1' });

  test('valida cantidad, línea y tipo', async () => {
    for (const body of [
      { botella_tipo: 'soplado_belini_1lt', cantidad: 0, linea: 'MANUAL' },
      { botella_tipo: 'soplado_belini_1lt', cantidad: 100, linea: 'TURBO' },
      { botella_tipo: 'soplado_inexistente', cantidad: 100, linea: 'MANUAL' }
    ]) {
      const res = await invocar('post', '/api/soplado/etiquetar', { body });
      expect(res.statusCode).toBe(400);
    }
    const movs = mockQuery.mock.calls.filter(c => /UPDATE inventario SET stock/.test(String(c[0])));
    expect(movs).toHaveLength(0);
  });

  test('sin blanco registrado avisa que sople primero', async () => {
    mundo.blanco = null;
    mundo.terminada = { id: 3, stock: 100 };
    const res = await invocar('post', '/api/soplado/etiquetar', { body: baseEtq() });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/Registra primero/);
  });

  test('sin stock en blanco suficiente se rechaza', async () => {
    mundo.blanco = { id: 9, stock: 100 };
    mundo.terminada = { id: 3, stock: 0 };
    mundo.etiquetaArt = { id: 5, stock: 10 };
    const res = await invocar('post', '/api/soplado/etiquetar', { body: baseEtq() });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/Solo hay 100 en blanco/);
  });

  test('descuenta blanco y etiqueta en MILL, suma terminada', async () => {
    mundo.blanco = { id: 9, stock: 5000 };
    mundo.terminada = { id: 3, stock: 100 };
    mundo.etiquetaArt = { id: 5, stock: 10 };
    const res = await invocar('post', '/api/soplado/etiquetar', { body: baseEtq() });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch(/Etiquetadas 2000/);
    const menos = mockQuery.mock.calls.filter(c => /UPDATE inventario SET stock = stock - \$1 WHERE id/.test(String(c[0])));
    expect(menos.map(c => c[1])).toEqual([[2000, 9], [2, 5]]);
    const mas = mockQuery.mock.calls.find(c => /UPDATE inventario SET stock = stock \+ \$1 WHERE id/.test(String(c[0])));
    expect(mas[1]).toEqual([2000, 3]);
  });

  test('sin etiqueta (VEGA) solo mueve blanco y terminada', async () => {
    mundo.blanco = { id: 9, stock: 5000 };
    mundo.terminada = { id: 3, stock: 0 };
    const res = await invocar('post', '/api/soplado/etiquetar', {
      body: { ...baseEtq(), botella_tipo: 'soplado_vega_900ml' }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch(/sin etiqueta/);
  });
});

describe('GET /api/soplado/lineas', () => {
  test('devuelve el molde actual de cada línea', async () => {
    const res = await invocar('get', '/api/soplado/lineas');

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.lineas).toHaveLength(2);
    expect(res.cuerpo.lineas[0]).toMatchObject({ linea: 'AUTOMATICA', molde_actual: 'Molde 1 Lt' });
  });

  test('sin la tabla avisa migracionPendiente', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('relation "soplado_lineas" does not exist'), { code: '42P01' }));
    const res = await invocar('get', '/api/soplado/lineas');

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.migracionPendiente).toBe(true);
  });
});
