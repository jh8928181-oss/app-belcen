/**
 * La conformidad creaba artículos nuevos cuando el nombre de la guía no
 * calzaba exacto con el inventario (caso T001-0005658: "Etiquetas b-1 1lt"
 * creó el id 95 en vez de sumar a "Etiqueta couche 90 gr x 1 lt B-1").
 *
 * Ahora los nombres se resuelven por capas (exacto → plano → tokens con un
 * solo candidato) y el INSERT solo ocurre cuando de verdad no existe ninguno.
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

const CANONICOS = [
  { id: 60, nombre: 'Etiqueta couche 90 gr x 1 lt B-1', stock: 101.53 },
  { id: 66, nombre: 'Etiqueta couche 90 gr x 1 lt Belini', stock: 7.31 },
  { id: 63, nombre: 'Etiqueta couche 90gr x 800 ml Don Lalo', stock: 26.57 }
];

function montar(ingreso) {
  mockQuery.mockImplementation(async (sql, params = []) => {
    if (/FROM ingresos_vigilancia WHERE id/.test(sql)) return { rows: [ingreso], rowCount: 1 };
    if (/LOWER\(BTRIM\(nombre\)\) = LOWER\(BTRIM\(\$1\)\)/.test(sql)) {
      const t = String(params[0]).trim().toLowerCase();
      return { rows: CANONICOS.filter(f => f.nombre.trim().toLowerCase() === t) };
    }
    if (/^SELECT id, nombre, stock FROM inventario$/.test(sql.trim())) return { rows: CANONICOS };
    if (/INSERT INTO inventario \(nombre, categoria, stock/.test(sql)) return { rows: [{ id: 200 }], rowCount: 1 };
    if (/UPDATE inventario SET stock = stock/.test(sql)) return { rows: [{ stock: 200 }], rowCount: 1 };
    if (/UPDATE ingresos_vigilancia SET estado/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

const ingresoCon = nombre => ({
  id: 5, numero_guia: 'T001-1', proveedor: 'P',
  items_json: JSON.stringify([{ nombre, cantidad_fisica: 100, cantidad_guia: 100 }])
});

const sqlDe = patron => mockQuery.mock.calls
  .map(c => ({ sql: String(c[0]), params: c[1] }))
  .filter(c => c.sql.includes(patron));

beforeEach(() => mockQuery.mockClear());

describe('POST /api/almacen/conformidad — no crea duplicados', () => {
  test('un nombre similar suma al artículo existente sin INSERT', async () => {
    montar(ingresoCon('Etiquetas b-1 1lt'));

    const res = await invocar('post', '/api/almacen/conformidad', {
      body: { ingreso_id: 5, usuario_almacen: 'admin' }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    expect(sqlDe('INSERT INTO inventario')).toHaveLength(0);
    const upd = sqlDe('UPDATE inventario SET stock = stock +');
    expect(upd).toHaveLength(1);
    expect(upd[0].params).toEqual([100, 60]);
  });

  test('un nombre ambiguo responde 409 con candidatos y no escribe nada', async () => {
    montar(ingresoCon('Etiqueta 1 lt'));

    const res = await invocar('post', '/api/almacen/conformidad', {
      body: { ingreso_id: 5, usuario_almacen: 'admin' }
    });

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.candidatos.map(c => c.id).sort()).toEqual([60, 66]);
    expect(sqlDe('INSERT INTO inventario')).toHaveLength(0);
    expect(sqlDe('UPDATE inventario SET stock = stock +')).toHaveLength(0);
  });

  test('lo que no existe sí se crea como artículo nuevo', async () => {
    montar(ingresoCon('Preforma 5 lt marciana'));

    const res = await invocar('post', '/api/almacen/conformidad', {
      body: {
        ingreso_id: 5, usuario_almacen: 'admin',
        items_ajustados: [{
          nombre: 'Preforma 5 lt marciana', categoria: 'PREFORMAS Y SERVICIOS', unidad_medida: 'MILL'
        }]
      }
    });

    expect(res.statusCode).toBe(200);
    expect(sqlDe('INSERT INTO inventario')).toHaveLength(1);
  });
});

describe('POST /api/almacen/resolver-items — el frontend solo pregunta lo nuevo', () => {
  test('clasifica unico, ninguno y ambiguo por ítem', async () => {
    montar(ingresoCon('x'));

    const res = await invocar('post', '/api/almacen/resolver-items', {
      body: { nombres: ['Etiquetas b-1 1lt', 'Preforma 5 lt marciana', 'Etiqueta 1 lt'] }
    });

    expect(res.statusCode).toBe(200);
    const porNombre = new Map(res.cuerpo.items.map(i => [i.nombre, i]));
    expect(porNombre.get('Etiquetas b-1 1lt').tipo).toBe('unico');
    expect(porNombre.get('Etiquetas b-1 1lt').articulo.id).toBe(60);
    expect(porNombre.get('Preforma 5 lt marciana').tipo).toBe('ninguno');
    expect(porNombre.get('Etiqueta 1 lt').tipo).toBe('ambiguo');
    expect(porNombre.get('Etiqueta 1 lt').candidatos).toHaveLength(2);
  });
});
