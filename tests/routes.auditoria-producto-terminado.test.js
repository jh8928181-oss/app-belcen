/**
 * Pestaña PRODUCTO TERMINADO de Auditoría: el stock actual en cajas y el
 * historial de qué lo subió (producción, ajustes) y qué lo bajó (salida con
 * su guía, o el despacho de una orden).
 *
 *   - /api/auditoria/producto-terminado devuelve { stock, movimientos };
 *   - la referencia del historial llega como frase y el servidor la desarma
 *     en guía / salida / pedido / producción, que es lo que la tabla pinta
 *     en columnas propias;
 *   - solo lee: ni INSERT ni UPDATE.
 */

const mockQuery = jest.fn();

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (...args) => mockQuery(...args),
    release: () => {}
  })
}));

jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, authMiddleware: (req, res, next) => next() };
});

const { app } = require('../index');

function resFalso() {
  const r = {
    statusCode: null, cuerpo: null, headersSent: false,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) {
      if (r.statusCode === null) r.statusCode = 200;
      r.cuerpo = cuerpo; r.headersSent = true; return r;
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
    { params: {}, body: {}, query: {}, usuario: 'admin', rol: 'admin', headers: {}, method, originalUrl: ruta },
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

const sqlDe = patron => mockQuery.mock.calls
  .map(c => String(c[0]))
  .filter(sql => sql.includes(patron));

const STOCK = [
  { producto_key: 'b1_1lt', nombre_producto: 'Aceite de Soya B-1 1 Lt', stock_cajas: 709, stock_minimo: 200, estado: 'OK' },
  { producto_key: 'belini_900ml', nombre_producto: 'Aceite de Soya Belini 900 ml', stock_cajas: 0, stock_minimo: 100, estado: 'SIN STOCK' }
];

/** Movimientos como los escribe el historial: producto_key y jamás articulo_id. */
const MOVIMIENTOS = [
  { id: 1326, fecha: '2026-11-10T22:45:55', tipo: 'SALIDA', origen: 'salidas',
    producto: 'Aceite de Soya Don Lalo Balde 20 Lt', producto_key: 'donlalo_20lt',
    cantidad: '100.000000', tipo_cambio: 'RESTA', stock_anterior: '469.000000',
    stock_nuevo: '369.000000', usuario: 'admin1',
    referencia: 'Despacho N° mwaze6xp4oix7o - guía T004-00007526' },
  { id: 1303, fecha: '2026-11-09T20:34:58', tipo: 'SALIDA', origen: 'pedido_venta',
    producto: 'Aceite de Soya B-1 1 Lt', producto_key: 'b1_1lt',
    cantidad: '2700.000000', tipo_cambio: 'RESTA', stock_anterior: '3409.000000',
    stock_nuevo: '709.000000', usuario: 'almacen1',
    referencia: 'Despacho pedido PED-2026-0007 - guía EG07-00004604' },
  { id: 1200, fecha: '2026-11-08T09:00:00', tipo: 'PRODUCCION', origen: 'envasado',
    producto: 'Aceite de Soya B-1 1 Lt', producto_key: 'b1_1lt',
    cantidad: '500.000000', tipo_cambio: 'SUMA', stock_anterior: '209.000000',
    stock_nuevo: '709.000000', usuario: 'envasado1',
    referencia: 'Producción de 500 cajas - Aceite de Soya B-1 1 Lt' },
  { id: 1180, fecha: '2026-11-07T18:20:00', tipo: 'AJUSTE', origen: 'producto_terminado',
    producto: 'Aceite de Soya Belini 900 ml', producto_key: 'belini_900ml',
    cantidad: '20.000000', tipo_cambio: 'RESTA', stock_anterior: '20.000000',
    stock_nuevo: '0.000000', usuario: 'admin1',
    referencia: 'Ajuste manual de producto terminado' }
];

function responder() {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM producto_terminado/.test(sql)) return { rows: STOCK, rowCount: STOCK.length };
    if (/FROM historial_inventario h/.test(sql)) return { rows: MOVIMIENTOS, rowCount: MOVIMIENTOS.length };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => mockQuery.mockClear());

describe('GET /api/auditoria/producto-terminado — stock y movimientos', () => {
  test('devuelve el stock actual y cada movimiento con su referencia desarmada', async () => {
    responder();

    const res = await invocar('get', '/api/auditoria/producto-terminado');

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.stock).toHaveLength(2);
    expect(res.cuerpo.stock[0]).toMatchObject({ producto_key: 'b1_1lt', stock_cajas: 709, estado: 'OK' });
    expect(res.cuerpo.stock[1].estado).toBe('SIN STOCK');
    expect(res.cuerpo.movimientos).toHaveLength(4);
  });

  test('la frase de la referencia se abre en guía, salida, pedido y producción', async () => {
    responder();

    const res = await invocar('get', '/api/auditoria/producto-terminado');
    const [salida, pedido, produccion, ajuste] = res.cuerpo.movimientos;

    // Salida manual: trae el despacho y la guía que originó la baja.
    expect(salida).toMatchObject({
      guia: 'T004-00007526',
      salida: 'mwaze6xp4oix7o',
      pedido: '',
      produccion: ''
    });
    // Despacho de una orden: la orden manda en la columna de pedido.
    expect(pedido).toMatchObject({ guia: 'EG07-00004604', salida: '', pedido: 'PED-2026-0007' });
    // Producción: la cantidad y la presentación que subieron el stock.
    expect(produccion).toMatchObject({ guia: '', salida: '', pedido: '', produccion: '500 cajas - Aceite de Soya B-1 1 Lt' });
    // Un ajuste no tiene guía ni salida: queda el motivo tal cual.
    expect(ajuste).toMatchObject({ guia: '', salida: '', pedido: '', produccion: '' });
    expect(ajuste.referencia).toBe('Ajuste manual de producto terminado');
  });

  test('solo movimientos de producto terminado y sin escrituras', async () => {
    responder();

    const res = await invocar('get', '/api/auditoria/producto-terminado', {
      query: { producto: 'b1_1lt', desde: '2026-11-01', hasta: '2026-11-30', q: 'belini' }
    });

    expect(res.statusCode).toBe(200);
    const select = sqlDe('FROM historial_inventario h');
    expect(select).toHaveLength(1);
    expect(select[0]).toMatch(/h\.producto_key IS NOT NULL/);
    expect(select[0]).toMatch(/h\.producto_key = /);
    // Los movimientos de insumos traen articulo_id: no deben colarse.
    expect(select[0]).not.toMatch(/articulo_id/);
    const escribes = mockQuery.mock.calls.filter(c => /^\s*(INSERT|UPDATE|DELETE)/i.test(String(c[0])));
    expect(escribes).toHaveLength(0);
    // Los cuatro filtros viajan como parámetros, nunca interpolados.
    const params = mockQuery.mock.calls.find(c => String(c[0]).includes('FROM historial_inventario h'))[1];
    expect(params).toEqual(['2026-11-01', '2026-11-30', '%belini%', 'b1_1lt']);
  });

  test('un error de base responde 500 sin romper', async () => {
    mockQuery.mockRejectedValue(new Error('caída puntual'));

    const res = await invocar('get', '/api/auditoria/producto-terminado');

    expect(res.statusCode).toBe(500);
    expect(res.cuerpo.success).toBe(false);
  });
});
