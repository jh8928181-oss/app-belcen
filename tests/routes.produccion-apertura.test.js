/**
 * Pruebas del flujo abrir/cerrar producción de envasado.
 *
 * El operario abre eligiendo SOLO el producto; la cantidad sale al cerrar.
 * Al cerrar se pregunta qué producto sigue. Reglas que se cuidan aquí:
 *
 *   1. Abrir exige presentación con receta y línea en marcha, igual que el
 *      reporte directo. No mueve stock: solo crea la fila EN_CURSO.
 *   2. Solo puede haber una producción abierta a la vez (409 si ya hay una).
 *   3. Cerrar exige cantidad entera válida y aplica los mismos movimientos
 *      que el reporte directo (mismo núcleo, mismos descuentos).
 *   4. Cerrar una producción ya cerrada o inexistente no toca nada.
 *   5. Borrar una producción abierta no devuelve nada: nunca movió stock.
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

// Solo se anula la autenticacion; los guards por rol se ejercen de verdad.
jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, authMiddleware: (req, res, next) => next() };
});

// Receta fija para no depender del motor real en el cierre exitoso.
jest.mock('../services/recipeService', () => {
  const real = jest.requireActual('../services/recipeService');
  return {
    ...real,
    calcularInsumosProduccion: async () => ([
      {
        insumo_id: 3, nombre: 'Preforma 1 Lt', cantidad: 500,
        unidad: 'UNIDADES', categoria: 'PREFORMAS Y SERVICIOS',
        obligatorio: true, nombre_producto: 'Aceite de Soya Belini 1 Lt'
      }
    ])
  };
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
    { params: {}, body: {}, query: {}, usuario: 'envasado_user', rol: 'envasado', headers: {}, method, originalUrl: ruta },
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

function sqlDe(patron) {
  return mockQuery.mock.calls
    .map(c => String(c[0]))
    .filter(s => s.includes(patron));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('POST /api/produccion/iniciar', () => {
  test('sin producto responde 400 sin tocar la base', async () => {
    const res = await invocar('post', '/api/produccion/iniciar', { body: { presentacion: '' } });
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('sin receta responde 400', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    const res = await invocar('post', '/api/produccion/iniciar', {
      body: { presentacion: 'ZZZ INEXISTENTE 123', fecha_produccion: '2026-10-08' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/receta/);
    expect(sqlDe('INSERT INTO reportes_produccion')).toHaveLength(0);
  });

  test('con linea en PARADO responde 409 y no crea nada', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [{ estado: 'PARADO' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/iniciar', {
      body: { presentacion: 'Aceite de Soya Belini 1 Lt' }
    });
    expect(res.statusCode).toBe(409);
    expect(sqlDe('INSERT INTO reportes_produccion')).toHaveLength(0);
  });

  test('si ya hay una abierta responde 409', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [], rowCount: 0 };
      if (/WHERE estado = 'EN_CURSO'/.test(sql)) {
        return { rows: [{ id: 3, presentacion: 'Aceite de Soya B-1 1 Lt' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/iniciar', {
      body: { presentacion: 'Aceite de Soya Belini 1 Lt' }
    });
    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.mensaje).toMatch(/Aceite de Soya B-1 1 Lt/);
    expect(sqlDe('INSERT INTO reportes_produccion')).toHaveLength(0);
  });

  test('abre EN_CURSO sin mover stock y devuelve el id', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [], rowCount: 0 };
      if (/WHERE estado = 'EN_CURSO'/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO reportes_produccion/.test(sql)) return { rows: [{ id: 7 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/iniciar', {
      body: { presentacion: 'Aceite de Soya Belini 1 Lt', fecha_produccion: '2026-10-08' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.reporte_id).toBe(7);
    expect(sqlDe('UPDATE inventario SET stock')).toHaveLength(0);
    expect(sqlDe('INSERT INTO producto_terminado')).toHaveLength(0);
    const ins = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO reportes_produccion'));
    expect(ins[1]).toEqual(expect.arrayContaining(['Aceite de Soya Belini 1 Lt', 'belini_1lt']));
    expect(String(ins[0])).toMatch(/EN_CURSO/);
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/produccion/cerrar', () => {
  test('cantidad inválida responde 400 sin tocar la base', async () => {
    for (const cantidad of [0, -5, 10.5, 'abc']) {
      mockQuery.mockReset();
      const res = await invocar('post', '/api/produccion/cerrar', {
        body: { reporte_id: 9, cantidad_cajas: cantidad, toneladas: 1 }
      });
      expect(res.statusCode).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    }
  });

  test('reporte inexistente responde 404', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM reportes_produccion WHERE id/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/cerrar', {
      body: { reporte_id: 99, cantidad_cajas: 100, toneladas: 1 }
    });
    expect(res.statusCode).toBe(404);
  });

  test('cerrar una ya cerrada responde 409 sin mover stock', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM reportes_produccion WHERE id/.test(sql)) {
        return { rows: [{ id: 9, presentacion: 'X', estado: 'CERRADO', producto_key: 'belini_1lt' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/cerrar', {
      body: { reporte_id: 9, cantidad_cajas: 100, toneladas: 1 }
    });
    expect(res.statusCode).toBe(409);
    expect(sqlDe('UPDATE inventario SET stock')).toHaveLength(0);
  });

  test('cierra la abierta: descuenta, suma cajas y marca CERRADO', async () => {
    mockQuery.mockImplementation(async (sql) => {
      const texto = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
      if (/FROM reportes_produccion WHERE id/.test(texto)) {
        return { rows: [{ id: 9, presentacion: 'Aceite de Soya Belini 1 Lt', producto_key: 'belini_1lt', estado: 'EN_CURSO' }], rowCount: 1 };
      }
      if (/FROM inventario WHERE id = ANY/.test(texto)) {
        return { rows: [{ id: 3, nombre: 'Preforma 1 Lt', stock: '9999' }], rowCount: 1 };
      }
      if (/UPDATE inventario SET stock = stock -/.test(texto)) return { rows: [{ stock: '9499' }], rowCount: 1 };
      if (/UPDATE inventario SET estado/.test(texto)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO historial_inventario/.test(texto)) return { rows: [], rowCount: 1 };
      if (/FROM producto_terminado WHERE producto_key/.test(texto)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO producto_terminado/.test(texto)) return { rows: [], rowCount: 1 };
      if (/UPDATE reportes_produccion SET cantidad_cajas/.test(texto)) return { rows: [], rowCount: 1 };
      if (/SELECT set_config/.test(texto)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/cerrar', {
      body: { reporte_id: 9, cantidad_cajas: 500, toneladas: 2.5 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch(/cerrada con 500 cajas/);
    const upd = mockQuery.mock.calls.find(c => /UPDATE reportes_produccion SET cantidad_cajas/.test(String(c[0])));
    expect(upd[1]).toEqual([500, 2.5, 9]);
    expect(sqlDe('UPDATE inventario SET stock = stock -').length).toBeGreaterThan(0);
    expect(sqlDe('COMMIT').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/produccion/eliminar con fila abierta', () => {
  test('borra directo sin devoluciones ni avisos', async () => {
    mockQuery.mockImplementation(async (sql) => {
      const texto = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
      if (/FROM reportes_produccion WHERE id/.test(texto)) {
        return { rows: [{ id: 9, presentacion: 'X', estado: 'EN_CURSO', cantidad_cajas: null }], rowCount: 1 };
      }
      if (/DELETE FROM reportes_produccion/.test(texto)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch(/en curso/);
    expect(sqlDe('UPDATE inventario SET stock')).toHaveLength(0);
    expect(sqlDe('INSERT INTO historial_inventario')).toHaveLength(0);
  });
});
