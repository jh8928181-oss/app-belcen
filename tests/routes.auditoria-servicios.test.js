/**
 * Pestaña SERVICIOS de Auditoría > Almacén: las botellas que llegan de los
 * servicios de soplado (SAUÑE / B&M) tal como las registró Almacén.
 *
 *   - /api/auditoria/servicios devuelve una fila por producto con proveedor,
 *     producto, cantidad en unidades y categoría (el JOIN con inventario);
 *   - solo lee: ni INSERT ni UPDATE;
 *   - excluye las guías documentales (con controles vinculados): esos
 *     botellas ya contaron con su control y duplicarían el total.
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

beforeEach(() => mockQuery.mockClear());

describe('GET /api/auditoria/servicios — botellas de SAUÑE / B&M', () => {
  test('devuelve proveedor, producto, cantidad en unidades y categoría por línea', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM servicios_guias_items/.test(sql)) {
        return {
          rows: [
            { fecha: '2026-10-24T08:00:00', servicio: 'SAUÑE', tipo_doc: 'GUIA', numero: 'G-111',
              producto: 'Botella Belini x 1 lt', cantidad: 5000, categoria: 'BOTELLAS Y GALONERAS' },
            { fecha: '2026-10-23T10:00:00', servicio: 'B&M DYLPLAST', tipo_doc: 'CONTROL', numero: 'C-07',
              producto: 'Botella de 900 ml - B-1', cantidad: 3000, categoria: null }
          ],
          rowCount: 2
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('get', '/api/auditoria/servicios', {});

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toHaveLength(2);
    expect(res.cuerpo[0]).toMatchObject({
      proveedor: 'SAUÑE',
      producto: 'Botella Belini x 1 lt',
      cantidad: 5000,
      categoria: 'BOTELLAS Y GALONERAS'
    });
    // Sin categoría en inventario cae al valor por defecto (botellas).
    expect(res.cuerpo[1].categoria).toBe('BOTELLAS Y GALONERAS');
    expect(res.cuerpo[1].cantidad).toBe(3000);
  });

  test('excluye guías documentales (con controles) y solo lee', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await invocar('get', '/api/auditoria/servicios', {});

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toEqual([]);
    const select = sqlDe('FROM servicios_guias_items');
    expect(select).toHaveLength(1);
    expect(select[0]).toMatch(/array_length\(g\.controles_ids, 1\)/);
    expect(select[0]).toMatch(/g\.tipo_doc = 'CONTROL'/);
    expect(select[0]).toMatch(/LEFT JOIN inventario inv ON inv\.id = i\.botella_id/);
    // Lectura pura: ninguna escritura contra la base.
    const escribes = mockQuery.mock.calls.filter(c => /^\s*(INSERT|UPDATE|DELETE)/i.test(String(c[0])));
    expect(escribes).toHaveLength(0);
  });

  test('un error de base responde 500 sin romper', async () => {
    mockQuery.mockRejectedValue(new Error('caída puntual'));

    const res = await invocar('get', '/api/auditoria/servicios', {});

    expect(res.statusCode).toBe(500);
    expect(res.cuerpo.success).toBe(false);
  });
});
