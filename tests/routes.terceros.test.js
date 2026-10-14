/**
 * Pruebas de pre-ingresos de terceros (Opción 1: stock en tránsito).
 *
 * Reglas que se cuidan aqui:
 *  1. El pre-ingreso NO mueve stock: solo anuncia que el tercero trajo
 *      botellas antes de su guía oficial (201 + código TERC-XXXX).
 *  2. Sin tercero, sin botella o sin cantidad estimada se rechaza con 400.
 *  3. Vincular la guía ingresa las botellas al stock y salda solos los
 *      pendientes de ese artículo (entero o nada, del más viejo al más
 *      nuevo), dejando la conciliación guía vs estimado en la respuesta.
 *  4. Vincular dos veces o repetir guía del mismo tercero da 409.
 *  5. Sin la tabla (migración pendiente) el listado avisa en vez de reventar.
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
    { params: {}, body: {}, query: {}, usuario: 'almacen1', rol: 'almacen', headers: {}, method, originalUrl: ruta },
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

// Estado programable por test: qué devuelve cada consulta.
const mundo = {
  preingreso: null,
  articulo: null,
  stock: 0,
  pendientes: [],
  fallaVincularDuplicada: false
};

function usarMundo() {
  mockQuery.mockImplementation(async (sql, params = []) => {
    const q = String(sql);
    if (/FROM terceros_preingresos WHERE id = \$1/.test(q)) {
      return { rows: mundo.preingreso ? [mundo.preingreso] : [] };
    }
    if (/FROM terceros_preingresos/.test(q) && /^SELECT/i.test(q.trim())) {
      return { rows: [] };
    }
    if (/SELECT id, nombre FROM inventario WHERE id/.test(q)) {
      return { rows: mundo.articulo ? [mundo.articulo] : [] };
    }
    if (/INSERT INTO terceros_preingresos/.test(q)) {
      return { rows: [{ id: 7 }], rowCount: 1 };
    }
    if (/SELECT nombre, stock FROM inventario WHERE id/.test(q)) {
      return { rows: [{ nombre: 'Botella X', stock: mundo.stock }] };
    }
    if (/UPDATE inventario SET stock = stock \+ \$1/.test(q)) {
      mundo.stock = mundo.stock + Number(params[0]);
      return { rows: [{ stock: mundo.stock }], rowCount: 1 };
    }
    if (/UPDATE inventario SET stock = stock - \$1/.test(q)) {
      mundo.stock = mundo.stock - Number(params[0]);
      return { rows: [{ stock: mundo.stock }], rowCount: 1 };
    }
    if (/SELECT stock FROM inventario WHERE id/.test(q)) {
      return { rows: [{ stock: mundo.stock }] };
    }
    if (/FROM ajustes_pendientes\s+WHERE articulo_id/.test(q)) {
      return { rows: mundo.pendientes.map(p => ({ ...p })) };
    }
    if (/UPDATE terceros_preingresos\s+SET estado/.test(q)) {
      if (mundo.fallaVincularDuplicada) {
        const e = new Error('duplicate key value violates unique constraint "idx_terceros_preingresos_guia"');
        e.code = '23505';
        throw e;
      }
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mundo.preingreso = null;
  mundo.articulo = null;
  mundo.stock = 0;
  mundo.pendientes = [];
  mundo.fallaVincularDuplicada = false;
  usarMundo();
});

describe('GET /api/terceros/preingresos', () => {
  test('lista vacía cuando no hay pre-ingresos', async () => {
    const res = await invocar('get', '/api/terceros/preingresos');
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.preingresos).toEqual([]);
  });

  test('sin la tabla avisa migracionPendiente en vez de reventar', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('relation "terceros_preingresos" does not exist'), { code: '42P01' }));
    const res = await invocar('get', '/api/terceros/preingresos');
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.migracionPendiente).toBe(true);
  });
});

describe('POST /api/terceros/preingresos', () => {
  test('rechaza sin tercero, sin botella o sin cantidad', async () => {
    for (const body of [
      { articulo_id: 3, cantidad_estimada: 100 },
      { tercero: 'T', cantidad_estimada: 100 },
      { tercero: 'T', articulo_id: 3, cantidad_estimada: 0 }
    ]) {
      const res = await invocar('post', '/api/terceros/preingresos', { body });
      expect(res.statusCode).toBe(400);
    }
  });

  test('rechaza si la botella no existe en inventario', async () => {
    mundo.articulo = null;
    const res = await invocar('post', '/api/terceros/preingresos', {
      body: { tercero: 'Soplados Norte', articulo_id: 99, cantidad_estimada: 5000 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/no existe en el inventario/);
  });

  test('registra sin mover stock y devuelve código TERC-XXXX', async () => {
    mundo.articulo = { id: 3, nombre: 'Botella Belini 1 Lt' };
    const res = await invocar('post', '/api/terceros/preingresos', {
      body: { tercero: 'Soplados Norte', articulo_id: 3, cantidad_estimada: 5000 }
    });
    expect(res.statusCode).toBe(201);
    expect(res.cuerpo.preingreso.codigo).toBe('TERC-0007');
    expect(res.cuerpo.preingreso.estado).toBe('PREINGRESO');
    const movimientos = mockQuery.mock.calls.filter(c => /UPDATE inventario SET stock/.test(String(c[0])));
    expect(movimientos).toHaveLength(0);
  });
});

describe('POST /api/terceros/preingresos/:id/vincular', () => {
  test('rechaza id inválido, guía vacía o cantidad inválida', async () => {
    const mala = await invocar('post', '/api/terceros/preingresos/x/vincular', { body: {} });
    expect(mala.statusCode).toBe(400);
    const sinGuia = await invocar('post', '/api/terceros/preingresos/7/vincular', {
      params: { id: '7' }, body: { cantidad_guia: 100 }
    });
    expect(sinGuia.statusCode).toBe(400);
    const sinCant = await invocar('post', '/api/terceros/preingresos/7/vincular', {
      params: { id: '7' }, body: { numero_guia: 'G-1', cantidad_guia: 0 }
    });
    expect(sinCant.statusCode).toBe(400);
  });

  test('responde 404 si el pre-ingreso no existe y 409 si ya se vinculó', async () => {
    mundo.preingreso = null;
    const falta = await invocar('post', '/api/terceros/preingresos/7/vincular', {
      params: { id: '7' }, body: { numero_guia: 'G-1', cantidad_guia: 100 }
    });
    expect(falta.statusCode).toBe(404);

    mundo.preingreso = { id: 7, codigo: 'TERC-0007', tercero: 'T', articulo_id: 3, articulo_nombre: 'B', cantidad_estimada: 5000, estado: 'VINCULADO', numero_guia: 'G-0' };
    const doble = await invocar('post', '/api/terceros/preingresos/7/vincular', {
      params: { id: '7' }, body: { numero_guia: 'G-1', cantidad_guia: 100 }
    });
    expect(doble.statusCode).toBe(409);
  });

  test('vincula: ingresa, salda pendientes y concilia guía vs estimado', async () => {
    mundo.preingreso = { id: 7, codigo: 'TERC-0007', tercero: 'Soplados Norte', articulo_id: 3, articulo_nombre: 'Botella X', cantidad_estimada: 5000, estado: 'PREINGRESO' };
    mundo.articulo = { id: 3, nombre: 'Botella X' };
    mundo.stock = 100;
    mundo.pendientes = [
      { id: 1, cantidad_pendiente: 200, articulo_nombre: 'Botella X' },
      { id: 2, cantidad_pendiente: 7000, articulo_nombre: 'Botella X' }
    ];

    const res = await invocar('post', '/api/terceros/preingresos/7/vincular', {
      params: { id: '7' }, body: { numero_guia: 'G-123', cantidad_guia: 6000 }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.ingresado).toBe(6000);
    expect(res.cuerpo.diferencia_recepcion).toBe(1000);
    expect(res.cuerpo.pendientes_saldadas).toEqual([1]);
    expect(res.cuerpo.pendientes_restantes).toBe(1);
    // 100 + 6000 - 200 = 5900 de stock final.
    expect(res.cuerpo.stock_final).toBe(5900);
    const saldado = mockQuery.mock.calls.find(c => /UPDATE ajustes_pendientes/.test(String(c[0])));
    expect(saldado[0]).toMatch(/vinculo_tipo = 'GUIA'/);
    expect(saldado[1][1]).toBe('G-123');
  });

  test('guía duplicada del mismo tercero da 409', async () => {
    mundo.preingreso = { id: 7, codigo: 'TERC-0007', tercero: 'Soplados Norte', articulo_id: 3, articulo_nombre: 'Botella X', cantidad_estimada: 5000, estado: 'PREINGRESO' };
    mundo.articulo = { id: 3, nombre: 'Botella X' };
    mundo.stock = 0;
    mundo.fallaVincularDuplicada = true;

    const res = await invocar('post', '/api/terceros/preingresos/7/vincular', {
      params: { id: '7' }, body: { numero_guia: 'G-123', cantidad_guia: 6000 }
    });

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.mensaje).toMatch(/ya fue vinculada/);
  });
});
