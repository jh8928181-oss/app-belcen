/**
 * Tests de DELETE /api/inventario/:id (solo admin).
 *
 * Reglas que se cuidan aqui:
 *  1. Solo el rol 'admin' puede borrar articulos del inventario. Los demas
 *      roles reciben 403 aunque el id exista (requerirRolAdmin, no el guard
 *      permisivo de almacen).
 *  2. Id invalido -> 400; articulo inexistente -> 404; nada se borra.
 *  3. El borrado queda en el historial con tipo ELIMINACION, para que la
 *      auditoria pueda rastrear quien quito que.
 *  4. Si guias, salidas o recetas todavia referencian el articulo, Postgres
 *      responde 23503 (FK) y la ruta devuelve 409 en vez de 500.
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

// Solo se anula la autenticacion; requerirRolAdmin se ejerce de verdad.
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
  return candidatas.pop().route.stack.map(l => l.handle);
}

async function invocar(method, ruta, req = {}) {
  const res = resFalso();
  const peticion = Object.assign(
    { params: {}, body: {}, query: {}, usuario: 'admin1', rol: 'admin', headers: {}, method, originalUrl: ruta },
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

function responder(reglas) {
  mockQuery.mockImplementation(async (sql) => {
    const texto = String(sql || '').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto)) return { rows: [], rowCount: 0 };
    for (const [patron, respuesta] of reglas) {
      if (patron instanceof RegExp ? patron.test(texto) : texto.includes(patron)) {
        if (respuesta instanceof Error) throw respuesta;
        return typeof respuesta === 'function' ? respuesta(texto) : respuesta;
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

const SQL = {
  filaInventario: /SELECT nombre, stock FROM inventario WHERE id = \$1/,
  borrarGuias: /DELETE FROM registro_ingresos_almacen WHERE articulo_id = \$1/,
  borrarSalidas: /DELETE FROM salidas_almacen WHERE articulo_id = \$1/,
  borrarRecetas: /DELETE FROM receta_insumos WHERE insumo_id = \$1/,
  borrarInventario: /DELETE FROM inventario WHERE id = \$1/,
  historial: /INSERT INTO historial_inventario/
};

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('DELETE /api/inventario/:id', () => {
  test('bloquea con 403 a rol almacen aunque el articulo exista', async () => {
    responder([[SQL.filaInventario, { rows: [{ nombre: 'X', stock: '5' }], rowCount: 1 }]]);
    const res = await invocar('delete', '/api/inventario/7', { params: { id: '7' }, rol: 'almacen', usuario: 'almacen1' });
    expect(res.statusCode).toBe(403);
    expect(res.cuerpo.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringMatching(SQL.borrarInventario), expect.anything());
  });

  test('rechaza id invalido con 400 sin tocar la base', async () => {
    const res = await invocar('delete', '/api/inventario/abc', { params: { id: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('devuelve 404 si el articulo no existe y revierte', async () => {
    responder([[SQL.filaInventario, { rows: [], rowCount: 0 }]]);
    const res = await invocar('delete', '/api/inventario/99', { params: { id: '99' } });
    expect(res.statusCode).toBe(404);
    expect(res.cuerpo.success).toBe(false);
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos).toContain('ROLLBACK');
    expect(textos.some(t => SQL.borrarInventario.test(t))).toBe(false);
  });

  test('el admin borra, registra ELIMINACION en historial y confirma', async () => {
    responder([
      [SQL.filaInventario, { rows: [{ nombre: 'ETIQUETA B-1 X 1LT', stock: '0.000000' }], rowCount: 1 }],
      [SQL.borrarGuias, { rows: [], rowCount: 0 }],
      [SQL.borrarSalidas, { rows: [], rowCount: 0 }],
      [SQL.borrarRecetas, { rows: [], rowCount: 0 }],
      [SQL.borrarInventario, { rows: [], rowCount: 1 }],
      [SQL.historial, { rows: [], rowCount: 1 }]
    ]);
    const res = await invocar('delete', '/api/inventario/5', { params: { id: '5' } });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    expect(res.cuerpo.mensaje).toMatch('ETIQUETA B-1 X 1LT');
    const llamadaHistorial = mockQuery.mock.calls.find(c => SQL.historial.test(String(c[0])));
    expect(llamadaHistorial).toBeDefined();
    expect(llamadaHistorial[1][0]).toBe('ELIMINACION');
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos).toContain('COMMIT');
  });

  test('borra en cascada: primero guias, salidas y recetas, y lo reporta', async () => {
    responder([
      [SQL.filaInventario, { rows: [{ nombre: 'Botella X', stock: '100' }], rowCount: 1 }],
      [SQL.borrarGuias, { rows: [], rowCount: 2 }],
      [SQL.borrarSalidas, { rows: [], rowCount: 1 }],
      [SQL.borrarRecetas, { rows: [], rowCount: 3 }],
      [SQL.borrarInventario, { rows: [], rowCount: 1 }],
      [SQL.historial, { rows: [], rowCount: 1 }]
    ]);
    const res = await invocar('delete', '/api/inventario/8', { params: { id: '8' } });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch('2 guías, 1 salidas, 3 recetas');
    const orden = mockQuery.mock.calls.map(c => String(c[0]));
    const iGuias = orden.findIndex(t => SQL.borrarGuias.test(t));
    const iSalidas = orden.findIndex(t => SQL.borrarSalidas.test(t));
    const iRecetas = orden.findIndex(t => SQL.borrarRecetas.test(t));
    const iInv = orden.findIndex(t => SQL.borrarInventario.test(t));
    expect(iGuias).toBeGreaterThanOrEqual(0);
    expect(iSalidas).toBeGreaterThan(iGuias);
    expect(iRecetas).toBeGreaterThan(iSalidas);
    expect(iInv).toBeGreaterThan(iRecetas);
  });

  test('responde 409 si el articulo esta referenciado (FK 23503)', async () => {
    const fk = new Error('violates foreign key');
    fk.code = '23503';
    responder([
      [SQL.filaInventario, { rows: [{ nombre: 'Caja X', stock: '10' }], rowCount: 1 }],
      [SQL.borrarInventario, fk]
    ]);
    const res = await invocar('delete', '/api/inventario/8', { params: { id: '8' } });
    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.success).toBe(false);
  });
});

describe('PUT /api/inventario/:id (renombrar, solo admin)', () => {
  const SQL_PUT = {
    fila: /SELECT nombre FROM inventario WHERE id = \$1/,
    duplicado: /SELECT id FROM inventario WHERE LOWER\(BTRIM\(nombre\)\)/,
    renombrar: /UPDATE inventario SET nombre = \$1 WHERE id = \$2/,
    historial: /INSERT INTO historial_inventario/
  };

  test('bloquea con 403 a rol almacen', async () => {
    const res = await invocar('put', '/api/inventario/7', {
      params: { id: '7' }, body: { nombre: 'X' }, rol: 'almacen', usuario: 'almacen1'
    });
    expect(res.statusCode).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rechaza nombre vacio con 400', async () => {
    const res = await invocar('put', '/api/inventario/7', { params: { id: '7' }, body: { nombre: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('devuelve 404 si el articulo no existe', async () => {
    responder([[SQL_PUT.fila, { rows: [], rowCount: 0 }]]);
    const res = await invocar('put', '/api/inventario/99', { params: { id: '99' }, body: { nombre: 'Nuevo' } });
    expect(res.statusCode).toBe(404);
  });

  test('devuelve 409 si el nombre ya lo usa otro articulo', async () => {
    responder([
      [SQL_PUT.fila, { rows: [{ nombre: 'Viejo' }], rowCount: 1 }],
      [SQL_PUT.duplicado, { rows: [{ id: 9 }], rowCount: 1 }]
    ]);
    const res = await invocar('put', '/api/inventario/7', { params: { id: '7' }, body: { nombre: 'Existente' } });
    expect(res.statusCode).toBe(409);
    expect(mockQuery.mock.calls.some(c => SQL_PUT.renombrar.test(String(c[0])))).toBe(false);
  });

  test('renombra, registra EDICION en historial y confirma', async () => {
    responder([
      [SQL_PUT.fila, { rows: [{ nombre: 'Preforma 23 GR' }], rowCount: 1 }],
      [SQL_PUT.duplicado, { rows: [], rowCount: 0 }],
      [SQL_PUT.renombrar, { rows: [], rowCount: 1 }],
      [SQL_PUT.historial, { rows: [], rowCount: 1 }]
    ]);
    const res = await invocar('put', '/api/inventario/7', { params: { id: '7' }, body: { nombre: 'Preforma 23.5 GR (PICO 26MM)' } });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    const llamadaHistorial = mockQuery.mock.calls.find(c => SQL_PUT.historial.test(String(c[0])));
    expect(llamadaHistorial[1][0]).toBe('EDICION');
    expect(llamadaHistorial[1][10]).toMatch('Preforma 23 GR');
  });
});
