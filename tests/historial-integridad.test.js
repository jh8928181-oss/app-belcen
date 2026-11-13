/**
 * Regresiones de integridad del historial de inventario (auditoría).
 *
 * Dos fallos reales que este archivo impide volver a cometer:
 *
 *  F1 — Refinado escribía en historial_inventario el `articulo_id` de
 *       stock_insumos_refinado (ids 1-10), que colisiona con los ids de
 *       inventario (botellas): la auditoría atribuía movimientos de químicos
 *       a artículos ajenos. Esos movimientos se identifican por origen +
 *       producto, SIN articulo_id.
 *
 *  F2 — Soplado descontaba stock por nombre sin pasar articulo_id: movimientos
 *       sin clave rompían la cadena stock_anterior → stock_nuevo y dejaban el
 *       stock actual distinto del último stock_nuevo registrado.
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
    { params: {}, body: {}, query: {}, usuario: 'auditor1', rol: 'almacen', headers: {}, method, originalUrl: ruta },
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

function insertsHistorial() {
  return mockQuery.mock.calls
    .filter(c => String(c[0]).includes('INSERT INTO historial_inventario'))
    .map(c => c[1]);
}

// Columna 5 ($5) de INSERT INTO historial_inventario = articulo_id.
function articuloIdDe(params) {
  return params[4];
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql) => {
    const q = String(sql);
    if (/SELECT id, aceite_json/.test(q)) return { rows: [] };
    if (/information_schema/.test(q)) return { rows: [{ column_name: 'linea' }] };
    if (/FROM estado_lineas/.test(q)) return { rows: [] };
    if (/FROM stock_insumos_refinado/.test(q)) {
      return { rows: [{ id: 7, nombre: 'TONSIL OPTIMUN 363', stock: 50 }] };
    }
    if (/UPDATE stock_insumos_refinado/.test(q)) return { rows: [{ stock: 40 }] };
    if (/INSERT INTO reportes_soplado/.test(q)) return { rows: [{ id: 11 }] };
    if (/FROM ajustes_pendientes/.test(q)) return { rows: [] };
    // Preforma, etiqueta, botella terminada y botella en blanco: la fila se
    // elige por el orden de las consultas del flujo. El stock es grande para
    // que los 5000 uds de los casos siempre quepan.
    if (/SELECT id, stock FROM inventario/.test(q)) {
      return { rows: [{ id: 101, stock: 100000 }] };
    }
    return { rows: [{ id: 5 }], rowCount: 1 };
  });
});

describe('F1: refinado no escribe articulo_id de otra tabla', () => {
  test('el movimiento de insumos del lote queda SIN articulo_id (ids ajenos a inventario)', async () => {
    const res = await invocar('post', '/api/refinado/guardar', {
      rol: 'refinado',
      body: {
        fecha_reporte: '2026-11-13',
        turno: 'DIA',
        lote: {
          lote: '0009', hora: '08:00', cantidad: 2.5, tanque: 'TK-1',
          proveedor: 'Proveedor X', fecha_produccion: '2026-11-13',
          estado: 'DISPONIBLE',
          insumos: [{ nombre: 'TONSIL OPTIMUN 363', cantidad: 12.5 }]
        },
        observaciones: '',
        produccion_manana: null
      }
    });

    expect(res.statusCode).toBe(200);
    const ins = insertsHistorial();
    expect(ins.length).toBeGreaterThanOrEqual(1);
    ins.forEach(p => expect(articuloIdDe(p)).toBeNull());
  });
});

describe('F2: soplado registra el articulo_id de cada movimiento', () => {
  test('registrar producción etiquetada historía preforma y etiqueta CON articulo_id', async () => {
    const res = await invocar('post', '/api/soplado/registrar', {
      rol: 'soplado',
      body: {
        preforma_nombre: 'Preforma 44 GR (2 LT)',
        botella_tipo: 'soplado_belini_1lt',
        cantidad_producida: 5000,
        etiquetada: true,
        usuario: 'soplado1'
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    const ins = insertsHistorial();
    // preforma (RESTA) + etiqueta (RESTA) + botella terminada (SUMA)
    expect(ins.length).toBe(3);
    ins.forEach(p => expect(articuloIdDe(p)).not.toBeNull());
  });

  test('etiquetar en blanco historía la etiqueta CON articulo_id', async () => {
    const res = await invocar('post', '/api/soplado/etiquetar', {
      rol: 'soplado',
      body: {
        botella_tipo: 'soplado_belini_1lt',
        cantidad: 5000,
        usuario: 'soplado1'
      }
    });

    expect(res.statusCode).toBe(200);
    const ins = insertsHistorial();
    // botella en blanco (RESTA) + etiqueta (RESTA) + botella terminada (SUMA)
    expect(ins.length).toBe(3);
    ins.forEach(p => expect(articuloIdDe(p)).not.toBeNull());
  });
});
