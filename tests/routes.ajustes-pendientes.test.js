/**
 * Pruebas de ajustes pendientes: envasado registra aunque falte stock.
 *
 * Reglas que se cuidan aqui:
 *  1. Si falta stock de un insumo, el producto terminado igual se registra:
 *      se descuenta lo que hay y lo que falta queda PENDIENTE (no se
 *      bloquea como antes con 400).
 *  2. El desglose guardado lleva solo lo APLICADO, para que al borrar el
 *      reporte se devuelva exactamente lo descontado.
 *  3. El pendiente se salda vinculándolo a un reporte (soplado) o guía que
 *      traiga el insumo: descuenta del stock actual y pasa a APLICADA.
 *  4. Sin stock suficiente al aplicar, o sin artículo creado, se rechaza
 *      con mensaje claro y no se mueve nada.
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

jest.mock('../services/recipeService', () => {
  const real = jest.requireActual('../services/recipeService');
  return {
    ...real,
    calcularInsumosProduccion: async () => ([
      {
        insumo_id: 3, nombre: 'Botella Belini x 1 Lt', cantidad: 6000,
        unidad: 'UNIDADES', categoria: 'BOTELLAS Y GALONERAS',
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

const SQL = {
  estadoLinea: /FROM estado_lineas/,
  stockAny: /FROM inventario WHERE id = ANY/,
  updateMenos: /UPDATE inventario SET stock = stock - \$1/,
  updateEstado: /UPDATE inventario SET estado/,
  insPT: /INSERT INTO producto_terminado/,
  insReporte: /INSERT INTO reportes_produccion/,
  insPendiente: /INSERT INTO ajustes_pendientes/,
  historial: /INSERT INTO historial_inventario/,
  selPendiente: /FROM ajustes_pendientes WHERE id = \$1/,
  updPendiente: /UPDATE ajustes_pendientes/,
  selArticulo: /FROM inventario WHERE id = \$1 FOR UPDATE/,
  listaPendientes: /FROM ajustes_pendientes/
};

const REPORTE_OK = {
  fecha_produccion: '2026-10-13',
  presentacion: 'Aceite de Soya Belini 1 Lt',
  cantidad_cajas: 500,
  toneladas: 5,
  lote: '0885'
};

function baseReporte() {
  mockQuery.mockImplementation(async (sql) => {
    const texto = String(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
    if (SQL.estadoLinea.test(texto)) return { rows: [], rowCount: 0 };
    if (SQL.stockAny.test(texto)) return { rows: [{ id: 3, nombre: 'Botella Belini x 1 Lt', stock: '5304' }], rowCount: 1 };
    if (SQL.updateMenos.test(texto)) return { rows: [{ stock: '0' }], rowCount: 1 };
    if (SQL.updateEstado.test(texto)) return { rows: [], rowCount: 1 };
    if (SQL.historial.test(texto)) return { rows: [], rowCount: 1 };
    if (/FROM producto_terminado WHERE producto_key/.test(texto)) return { rows: [], rowCount: 0 };
    if (SQL.insPT.test(texto)) return { rows: [], rowCount: 1 };
    if (SQL.insReporte.test(texto)) return { rows: [{ id: 11 }], rowCount: 1 };
    if (SQL.insPendiente.test(texto)) return { rows: [], rowCount: 1 };
    if (/SELECT set_config/.test(texto)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
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

describe('POST /api/produccion/reporte con faltantes', () => {
  test('registra igual, descuenta lo que hay y deja pendiente el resto', async () => {
    baseReporte();
    const res = await invocar('post', '/api/produccion/reporte', { body: REPORTE_OK });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.advertencia).toBe(true);
    expect(res.cuerpo.mensaje).toMatch(/pendiente/);
    // Descontó lo disponible (5304 de 6000).
    const menos = mockQuery.mock.calls.find(c => SQL.updateMenos.test(String(c[0])));
    expect(menos[1]).toEqual([5304, 3]);
    // El pendiente es la diferencia (696) atado al reporte 11.
    // Params: [reporte_id, articulo_id, nombre, cantidad, usuario] (origen va literal).
    const pend = mockQuery.mock.calls.find(c => SQL.insPendiente.test(String(c[0])));
    expect(pend).toBeDefined();
    expect(pend[1][0]).toBe(11);
    expect(pend[1][1]).toBe(3);
    expect(pend[1][3]).toBe(696);
    // El producto terminado sí se sumó completo.
    expect(mockQuery.mock.calls.some(c => SQL.insPT.test(String(c[0])))).toBe(true);
  });

  test('con stock total registra sin pendientes ni advertencia', async () => {
    baseReporte();
    mockQuery.mockImplementation(async (sql) => {
      const texto = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
      if (SQL.estadoLinea.test(texto)) return { rows: [], rowCount: 0 };
      if (SQL.stockAny.test(texto)) return { rows: [{ id: 3, nombre: 'Botella Belini x 1 Lt', stock: '99999' }], rowCount: 1 };
      if (SQL.updateMenos.test(texto)) return { rows: [{ stock: '93999' }], rowCount: 1 };
      if (SQL.updateEstado.test(texto)) return { rows: [], rowCount: 1 };
      if (SQL.historial.test(texto)) return { rows: [], rowCount: 1 };
      if (/FROM producto_terminado WHERE producto_key/.test(texto)) return { rows: [], rowCount: 0 };
      if (SQL.insPT.test(texto)) return { rows: [], rowCount: 1 };
      if (SQL.insReporte.test(texto)) return { rows: [{ id: 12 }], rowCount: 1 };
      if (/SELECT set_config/.test(texto)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/reporte', { body: REPORTE_OK });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.advertencia).toBeFalsy();
    expect(mockQuery.mock.calls.some(c => SQL.insPendiente.test(String(c[0])))).toBe(false);
  });

  test('insumo inexistente queda pendiente sin articulo_id', async () => {
    baseReporte();
    mockQuery.mockImplementation(async (sql) => {
      const texto = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
      if (SQL.estadoLinea.test(texto)) return { rows: [], rowCount: 0 };
      if (SQL.stockAny.test(texto)) return { rows: [], rowCount: 0 };
      if (/FROM producto_terminado WHERE producto_key/.test(texto)) return { rows: [], rowCount: 0 };
      if (SQL.insPT.test(texto)) return { rows: [], rowCount: 1 };
      if (SQL.insReporte.test(texto)) return { rows: [{ id: 13 }], rowCount: 1 };
      if (SQL.insPendiente.test(texto)) return { rows: [], rowCount: 1 };
      if (SQL.historial.test(texto)) return { rows: [], rowCount: 1 };
      if (/SELECT set_config/.test(texto)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/produccion/reporte', { body: REPORTE_OK });

    expect(res.statusCode).toBe(200);
    expect(mockQuery.mock.calls.some(c => SQL.updateMenos.test(String(c[0])))).toBe(false);
    const pend = mockQuery.mock.calls.find(c => SQL.insPendiente.test(String(c[0])));
    expect(pend[1][1]).toBeNull();
    expect(pend[1][3]).toBe(6000);
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/almacen/ajustes-pendientes', () => {
  test('lista pendientes ordenados', async () => {
    mockQuery.mockImplementation(async () => ({
      rows: [{ id: 1, estado: 'PENDIENTE', articulo_nombre: 'Botella X', cantidad_pendiente: '696' }],
      rowCount: 1
    }));
    const res = await invocar('get', '/api/almacen/ajustes-pendientes');
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.pendientes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('POST /api/almacen/ajustes-pendientes/:id/aplicar', () => {
  const PEND = {
    id: 5, estado: 'PENDIENTE', cantidad_pendiente: '696',
    articulo_id: 3, articulo_nombre: 'Botella Belini x 1 Lt'
  };

  function baseAplicar(stock) {
    mockQuery.mockImplementation(async (sql) => {
      const texto = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
      if (SQL.selPendiente.test(texto)) return { rows: [Object.assign({}, PEND)], rowCount: 1 };
      if (SQL.selArticulo.test(texto)) return { rows: [{ nombre: 'Botella Belini x 1 Lt', stock }], rowCount: 1 };
      if (SQL.updateMenos.test(texto)) return { rows: [{ stock: String(Number(stock) - 696) }], rowCount: 1 };
      if (SQL.updateEstado.test(texto)) return { rows: [], rowCount: 1 };
      if (SQL.historial.test(texto)) return { rows: [], rowCount: 1 };
      if (SQL.updPendiente.test(texto)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  test('aplica vinculado a guia: descuenta y marca APLICADA', async () => {
    baseAplicar('1000');
    const res = await invocar('post', '/api/almacen/ajustes-pendientes/5/aplicar', {
      params: { id: '5' },
      body: { vinculo_tipo: 'GUIA', vinculo_ref: 'T009-99' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch(/GUIA T009-99/);
    const menos = mockQuery.mock.calls.find(c => SQL.updateMenos.test(String(c[0])));
    expect(menos[1]).toEqual([696, 3]);
    const upd = mockQuery.mock.calls.find(c => SQL.updPendiente.test(String(c[0])));
    expect(upd[1][0]).toBe(696);
    expect(upd[1][1]).toBe('GUIA');
  });

  test('sin stock suficiente rechaza sin mover nada', async () => {
    baseAplicar('100');
    const res = await invocar('post', '/api/almacen/ajustes-pendientes/5/aplicar', {
      params: { id: '5' },
      body: { vinculo_tipo: 'SOPLADO', vinculo_ref: '12' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/sin stock suficiente/);
    expect(mockQuery.mock.calls.some(c => SQL.updateMenos.test(String(c[0])))).toBe(false);
    expect(mockQuery.mock.calls.some(c => SQL.updPendiente.test(String(c[0])))).toBe(false);
  });

  test('articulo inexistente pide crearlo primero', async () => {
    mockQuery.mockImplementation(async (sql) => {
      const texto = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
      if (SQL.selPendiente.test(texto)) {
        return { rows: [{ id: 6, estado: 'PENDIENTE', cantidad_pendiente: '10', articulo_id: null, articulo_nombre: 'Insumo Fantasma' }], rowCount: 1 };
      }
      if (/FROM inventario WHERE LOWER/.test(texto)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/almacen/ajustes-pendientes/6/aplicar', {
      params: { id: '6' },
      body: { vinculo_tipo: 'GUIA', vinculo_ref: 'T009-1' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/Créalo primero/);
  });

  test('ya aplicada responde 409 y validaciones 400', async () => {
    mockQuery.mockImplementation(async (sql) => {
      const texto = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto.trim())) return { rows: [], rowCount: 0 };
      if (SQL.selPendiente.test(texto)) {
        return { rows: [{ id: 7, estado: 'APLICADA', cantidad_pendiente: '5', articulo_id: 3, articulo_nombre: 'X' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const ya = await invocar('post', '/api/almacen/ajustes-pendientes/7/aplicar', {
      params: { id: '7' },
      body: { vinculo_tipo: 'GUIA', vinculo_ref: 'T009-1' }
    });
    expect(ya.statusCode).toBe(409);
    const mala = await invocar('post', '/api/almacen/ajustes-pendientes/7/aplicar', {
      params: { id: '7' },
      body: { vinculo_tipo: 'X', vinculo_ref: '' }
    });
    expect(mala.statusCode).toBe(400);
  });
});
