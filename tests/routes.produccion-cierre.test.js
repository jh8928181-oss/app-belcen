/**
 * Pruebas del pase a auditoría al cerrar producción.
 *
 * Reglas que se cuidan aqui:
 *  1. /api/produccion/informes devuelve cada registro con sus datos del
 *      formulario de cierre (fecha, presentación, cant, UM, TN, obs, estado).
 *  2. El cierre diario solo consolida producciones cerradas: las EN_CURSO
 *      no tienen cantidad, no se tocan ni se borran.
 *  3. Sin cerradas en la fecha se rechaza con 400 en vez de consolidar vacío.
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

const mundo = { reportes: [] };

beforeEach(() => {
  mockQuery.mockReset();
  mundo.reportes = [];
  mockQuery.mockImplementation(async (sql) => {
    const q = String(sql);
    if (/FROM reportes_produccion/.test(q) && /^SELECT/i.test(q.trim())) {
      // Emula a Postgres: el cierre pide COALESCE(estado,'') <> 'EN_CURSO'.
      let rows = mundo.reportes.map(r => ({ ...r }));
      if (/EN_CURSO/.test(q)) rows = rows.filter(r => (r.estado || '') !== 'EN_CURSO');
      return { rows };
    }
    return { rows: [], rowCount: 1 };
  });
});

describe('GET /api/produccion/informes', () => {
  test('cada registro trae UM y estado como el formulario de cierre', async () => {
    mundo.reportes = [{
      id: 1, fecha_produccion: new Date('2026-10-13'), presentacion: 'Aceite Belini 1 Lt',
      cantidad_cajas: 300, unidad_medida: 'CAJAS', toneladas: 3, estado: 'CERRADO',
      usuario_registro: 'envasado_user', observaciones: '0997 | Tapa X',
      desglose_insumos: JSON.stringify([{ nombre: 'Botella', cantidad: 3600, unidad_medida: 'UNIDADES' }])
    }];
    const res = await invocar('get', '/api/produccion/informes');
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo[0]).toMatchObject({
      presentacion: 'Aceite Belini 1 Lt',
      cantidad_cajas: 300,
      unidad_medida: 'CAJAS',
      toneladas: 3,
      estado: 'CERRADO',
      observaciones: '0997 | Tapa X'
    });
  });
});

describe('POST /api/produccion/cierre', () => {
  const cerr = {
    id: 1, fecha_produccion: new Date('2026-10-13T12:00:00'), presentacion: 'Aceite Belini 1 Lt',
    cantidad_cajas: 300, unidad_medida: 'CAJAS', toneladas: 3, estado: 'CERRADO', observaciones: '0997'
  };
  const curso = {
    id: 2, fecha_produccion: new Date('2026-10-13T08:00:00'), presentacion: 'Aceite B-1 1 Lt',
    cantidad_cajas: null, unidad_medida: 'CAJAS', toneladas: null, estado: 'EN_CURSO', observaciones: ''
  };

  test('consolida solo cerradas y no borra las en curso', async () => {
    mundo.reportes = [cerr, curso];
    const res = await invocar('post', '/api/produccion/cierre', {
      body: { fecha_cierre: '2026-10-13', usuario: 'admin1' }
    });
    expect(res.statusCode).toBe(200);
    const ins = mockQuery.mock.calls.find(c => /INSERT INTO historial_cierres_produccion/.test(String(c[0])));
    expect(ins).toBeDefined();
    const detalle = JSON.parse(ins[1][4]);
    expect(detalle).toHaveLength(1);
    expect(detalle[0]).toMatchObject({ presentacion: 'Aceite Belini 1 Lt', cant: 300, um: 'CAJAS', tn: 3, obs: '0997' });
    const del = mockQuery.mock.calls.find(c => /DELETE FROM reportes_produccion/.test(String(c[0])));
    expect(String(del[0])).toMatch(/EN_CURSO/);
  });

  test('sin cerradas en la fecha se rechaza y no escribe nada', async () => {
    mundo.reportes = [curso];
    const res = await invocar('post', '/api/produccion/cierre', {
      body: { fecha_cierre: '2026-10-13', usuario: 'admin1' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/en curso no se tocan/);
    const ins = mockQuery.mock.calls.filter(c => /INSERT INTO historial_cierres_produccion/.test(String(c[0])));
    const del = mockQuery.mock.calls.filter(c => /DELETE FROM reportes_produccion/.test(String(c[0])));
    expect(ins).toHaveLength(0);
    expect(del).toHaveLength(0);
  });
});
