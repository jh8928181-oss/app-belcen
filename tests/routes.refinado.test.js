/**
 * Pruebas del reporte de refinado por lotes.
 *
 * Regla que se cuida aqui: cada lote guarda quién lo registró, para que el
 * reporte muestre el responsable de cada lote y no solo el último que tocó
 * el turno (usuario_registro del reporte).
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
    { params: {}, body: {}, query: {}, usuario: 'refinado1', rol: 'refinado', headers: {}, method, originalUrl: ruta },
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

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql) => {
    const q = String(sql);
    if (/SELECT id, aceite_json/.test(q)) return { rows: [] };
    return { rows: [{ id: 5 }], rowCount: 1 };
  });
});

describe('POST /api/refinado/guardar', () => {
  test('el lote guarda el usuario que lo registró', async () => {
    const res = await invocar('post', '/api/refinado/guardar', {
      body: {
        fecha_reporte: '2026-10-14',
        turno: 'DIA',
        lote: {
          lote: '0001', hora: '08:00', cantidad: 2.5, tanque: 'TK-1',
          proveedor: 'Proveedor X', fecha_produccion: '2026-10-14',
          estado: 'DISPONIBLE', insumos: []
        },
        observaciones: 'Sin novedad',
        produccion_manana: null
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    const final = mockQuery.mock.calls.find(c => /RETURNING id/.test(String(c[0])));
    expect(final).toBeDefined();
    const lotes = JSON.parse(final[1][2]);
    expect(lotes).toHaveLength(1);
    expect(lotes[0].lote).toBe('0001');
    expect(lotes[0].usuario).toBe('refinado1');
  });
});
