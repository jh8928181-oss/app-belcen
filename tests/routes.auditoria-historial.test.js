/**
 * Pestaña "Historial de Movimientos de Inventario" de Auditoría.
 *
 * Los filtros (tipo, desde, hasta, búsqueda) viajan como parámetros y cada
 * uno va entre paréntesis: se unen con AND y un OR sin cerrar tendría más
 * precedencia, con lo que la búsqueda vacía dejaba el WHERE entero en
 * verdadero y el panel devolvía todo sin filtrar.
 *
 *   - sin filtros, la consulta sale sin parámetros (ni ::timestamp sobre '');
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

const FILAS = [
  { id: 9, fecha: '2026-11-10T22:45:55', tipo: 'SALIDA', origen: 'salidas',
    producto: 'Aceite de Soya B-1 1 Lt', articulo_id: null, producto_key: 'b1_1lt',
    cantidad: '100', tipo_cambio: 'RESTA', usuario: 'almacen1',
    referencia: 'Despacho N° abc123 - guía T004-00007526' },
  { id: 8, fecha: '2026-11-09T08:00:00', tipo: 'ENTRADA', origen: 'conformidad',
    producto: 'Botella Belini x 900 ml', articulo_id: 42, producto_key: null,
    cantidad: '500', tipo_cambio: 'SUMA', usuario: 'vigilancia1', referencia: null }
];

function responder() {
  mockQuery.mockImplementation(async () => ({ rows: FILAS, rowCount: FILAS.length }));
}

const consultaHistorial = () => mockQuery.mock.calls
  .map(c => String(c[0]))
  .find(sql => sql.includes('FROM historial_inventario'));

beforeEach(() => mockQuery.mockClear());

describe('GET /api/auditoria/historial — movimientos de inventario', () => {
  test('sin filtros la consulta sale sin parámetros y sin ::timestamp sobre vacío', async () => {
    responder();

    const res = await invocar('get', '/api/auditoria/historial', { query: {} });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toHaveLength(2);
    const sql = consultaHistorial();
    // Sin WHERE: no hay filtros que aplicar y no se manda nada.
    expect(sql).not.toMatch(/WHERE/);
    const params = mockQuery.mock.calls.find(c => String(c[0]).includes('FROM historial_inventario'))[1];
    expect(params).toEqual([]);
    // Nunca un ::timestamp sobre cadena vacía, que revienta en Postgres.
    expect(sql).not.toMatch(/::timestamp/);
  });

  test('cada filtro viaja entre paréntesis para que el OR no escape', async () => {
    responder();

    const res = await invocar('get', '/api/auditoria/historial', {
      query: { tipo: 'SALIDA', desde: '2026-11-01', hasta: '2026-11-30', q: 'guía' }
    });

    expect(res.statusCode).toBe(200);
    const sql = consultaHistorial();
    expect(sql).toMatch(/\(tipo = \$1\)/);
    expect(sql).toMatch(/\(fecha >= \$2::timestamp\)/);
    expect(sql).toMatch(/\(fecha <= \(\$3::timestamp \+ interval '1 day'\)\)/);
    // La búsqueda va entera entre paréntesis: sus tres OR son los que
    // escapaban del AND y dejaban el resto de filtros sin aplicar.
    expect(sql).toMatch(/\(LOWER\(producto\) LIKE LOWER\(\$4\) OR LOWER\(COALESCE\(usuario,''\)\) LIKE LOWER\(\$4\) OR LOWER\(COALESCE\(referencia,''\)\) LIKE LOWER\(\$4\)\)/);
    // Los cuatro se unen con AND: si alguno abriera un OR suelto, los
    // demás dejarían de aplicar.
    expect(sql.match(/ AND /g)).toHaveLength(3);
    const params = mockQuery.mock.calls.find(c => String(c[0]).includes('FROM historial_inventario'))[1];
    expect(params).toEqual(['SALIDA', '2026-11-01', '2026-11-30', '%guía%']);
  });

  test('solo lee: ni INSERT ni UPDATE', async () => {
    responder();

    await invocar('get', '/api/auditoria/historial', { query: { tipo: 'ENTRADA' } });

    const escribes = mockQuery.mock.calls.filter(c => /^\s*(INSERT|UPDATE|DELETE)/i.test(String(c[0])));
    expect(escribes).toHaveLength(0);
  });

  test('un error de base responde 500 sin romper', async () => {
    mockQuery.mockRejectedValue(new Error('caída puntual'));

    const res = await invocar('get', '/api/auditoria/historial');

    expect(res.statusCode).toBe(500);
    expect(res.cuerpo.success).toBe(false);
  });
});
