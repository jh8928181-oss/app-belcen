/**
 * Tests del circuito de maquila externa (SAUÑE / B&M DYLPLAST).
 *
 * Reglas que se cuidan aqui:
 *  1. Solo etiquetas o preformas salen al servicio, en millares y con stock
 *      suficiente. Otros articulos y servicios desconocidos se rechazan.
 *  2. El control interno NO mueve stock: es un anuncio pendiente de guia.
 *  3. La guia descuenta 1 etiqueta + 1 preforma por botella (UND a MILL) y
 *      suma las botellas al inventario, todo en una transaccion.
 *  4. El numero de guia/control no se duplica por servicio.
 *  5. La guia nace PENDIENTE de factura y se le vincula despues.
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

// Solo se anula la autenticacion; los guards por rol se ejercen de verdad.
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
        return typeof respuesta === 'function' ? respuesta(texto) : respuesta;
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

const SQL = {
  artEnvio: /SELECT nombre, categoria, stock FROM inventario WHERE id = \$1/,
  artGuia: /SELECT nombre, stock FROM inventario WHERE id = \$1/,
  botella: /SELECT id, stock FROM inventario WHERE LOWER\(BTRIM\(nombre\)\)/,
  updateMenos: /UPDATE inventario SET stock = stock - \$1/,
  updateMas: /UPDATE inventario SET stock = stock \+ \$1/,
  insEnvio: /INSERT INTO servicios_envios/,
  insGuia: /INSERT INTO servicios_guias/,
  dupGuia: /SELECT id FROM servicios_guias WHERE servicio/,
  updFactura: /UPDATE servicios_guias SET factura_numero/,
  historial: /INSERT INTO historial_inventario/,
  receta: /FROM recetas WHERE producto_key/
};

const GUIA_BASE = {
  servicio: 'SAUÑE', tipo_doc: 'GUIA', numero: 'T009-1', fecha: '2026-10-08',
  producto: 'Botella B-1 x 1 Lt', cantidad: 600,
  etiqueta_id: 10, preforma_id: 20
};

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('POST /api/servicios/envios', () => {
  test('rechaza servicio desconocido', async () => {
    const res = await invocar('post', '/api/servicios/envios', { body: { servicio: 'X', articulo_id: 1, cantidad: 5 } });
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rechaza articulo que no es etiqueta ni preforma', async () => {
    responder([[SQL.artEnvio, { rows: [{ nombre: 'Caja X', categoria: 'CAJAS', stock: '100' }], rowCount: 1 }]]);
    const res = await invocar('post', '/api/servicios/envios', { body: { servicio: 'SAUÑE', articulo_id: 3, cantidad: 5 } });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch('etiquetas o preformas');
  });

  test('rechaza stock insuficiente sin mover nada', async () => {
    responder([[SQL.artEnvio, { rows: [{ nombre: 'Et X', categoria: 'ETIQUETAS', stock: '2' }], rowCount: 1 }]]);
    const res = await invocar('post', '/api/servicios/envios', { body: { servicio: 'SAUÑE', articulo_id: 4, cantidad: 5 } });
    expect(res.statusCode).toBe(400);
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos.some(t => SQL.updateMenos.test(t))).toBe(false);
    expect(textos).toContain('ROLLBACK');
  });

  test('registra el envio, descuenta e historialea', async () => {
    responder([
      [SQL.artEnvio, { rows: [{ nombre: 'Et X', categoria: 'ETIQUETAS', stock: '10' }], rowCount: 1 }],
      [SQL.updateMenos, { rows: [], rowCount: 1 }],
      [SQL.insEnvio, { rows: [], rowCount: 1 }],
      [SQL.historial, { rows: [], rowCount: 1 }]
    ]);
    const res = await invocar('post', '/api/servicios/envios', { body: { servicio: 'SAUÑE', articulo_id: 4, cantidad: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    const upd = mockQuery.mock.calls.find(c => SQL.updateMenos.test(String(c[0])));
    expect(upd[1]).toEqual([5, 4]);
    const hist = mockQuery.mock.calls.find(c => SQL.historial.test(String(c[0])));
    expect(hist[1][0]).toBe('SALIDA');
  });
});

describe('POST /api/servicios/guias', () => {
  test('el CONTROL no mueve stock y queda pendiente', async () => {
    responder([
      [/SELECT id FROM servicios_guias/, { rows: [], rowCount: 0 }],
      [SQL.insGuia, { rows: [], rowCount: 1 }]
    ]);
    const res = await invocar('post', '/api/servicios/guias', {
      body: { servicio: 'SAUÑE', tipo_doc: 'CONTROL', numero: 'CI-1', producto: 'Botella X', cantidad: 100 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch('pendiente de guía');
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos.some(t => /UPDATE inventario/.test(t))).toBe(false);
    expect(textos.some(t => SQL.historial.test(t))).toBe(false);
  });

  test('rechaza numero duplicado por servicio', async () => {
    responder([[/SELECT id FROM servicios_guias/, { rows: [{ id: 1 }], rowCount: 1 }]]);
    const res = await invocar('post', '/api/servicios/guias', {
      body: { servicio: 'SAUÑE', tipo_doc: 'GUIA', numero: 'T009-1', producto: 'Botella X', cantidad: 100, etiqueta_id: 10, preforma_id: 20 }
    });
    expect(res.statusCode).toBe(409);
  });

  test('la GUIA descuenta 1 a 1 (UND a MILL) y suma botellas', async () => {
    // SELECTs por id: etiqueta 10 (stock 5), preforma 20 (stock 5), botella por nombre.
    mockQuery.mockImplementation(async (sql, params) => {
      const texto = String(sql || '').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto)) return { rows: [], rowCount: 0 };
      if (/SELECT id FROM servicios_guias/.test(texto)) return { rows: [], rowCount: 0 };
      if (SQL.artGuia.test(texto)) {
        return { rows: [{ nombre: params[0] === 10 ? 'Et X' : 'Pref Y', stock: '5' }], rowCount: 1 };
      }
      if (SQL.botella.test(texto)) return { rows: [{ id: 30, stock: '100' }], rowCount: 1 };
      if (SQL.updateMenos.test(texto) || SQL.updateMas.test(texto)) return { rows: [], rowCount: 1 };
      if (/UPDATE inventario SET estado/.test(texto)) return { rows: [], rowCount: 1 };
      if (SQL.insGuia.test(texto) || SQL.historial.test(texto)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await invocar('post', '/api/servicios/guias', { body: GUIA_BASE });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.mensaje).toMatch('0.6 MILLARES');
    const menos = mockQuery.mock.calls.filter(c => SQL.updateMenos.test(String(c[0])));
    expect(menos).toHaveLength(2);
    expect(menos[0][1][0]).toBeCloseTo(0.6, 6);
    const mas = mockQuery.mock.calls.find(c => SQL.updateMas.test(String(c[0])));
    expect(mas[1]).toEqual([600, 30]);
  });

  test('la GUIA exige etiqueta y preforma si no hay receta', async () => {
    responder([
      [/SELECT id FROM servicios_guias/, { rows: [], rowCount: 0 }],
      [SQL.receta, { rows: [], rowCount: 0 }]
    ]);
    const res = await invocar('post', '/api/servicios/guias', {
      body: { servicio: 'SAUÑE', tipo_doc: 'GUIA', numero: 'T009-2', producto: 'Botella X', cantidad: 100, producto_key: 'xxx' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch('etiqueta');
  });
});

describe('POST /api/servicios/guias/:id/factura', () => {
  test('vincula la factura a la guia', async () => {
    responder([[/UPDATE servicios_guias SET factura_numero/, { rows: [], rowCount: 1 }]]);
    const res = await invocar('post', '/api/servicios/guias/4/factura', { params: { id: '4' }, body: { factura_numero: 'F001-9' } });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
  });

  test('rechaza factura vacia y guia inexistente', async () => {
    const vacia = await invocar('post', '/api/servicios/guias/4/factura', { params: { id: '4' }, body: { factura_numero: '' } });
    expect(vacia.statusCode).toBe(400);
    responder([[/UPDATE servicios_guias SET factura_numero/, { rows: [], rowCount: 0 }]]);
    const falta = await invocar('post', '/api/servicios/guias/99/factura', { params: { id: '99' }, body: { factura_numero: 'F001-9' } });
    expect(falta.statusCode).toBe(404);
  });
});

describe('GET /api/servicios', () => {
  test('el panel trae servicios, guias y pendientes', async () => {
    responder([
      [/FROM servicios_envios GROUP BY/, { rows: [{ servicio: 'SAUÑE', articulo_id: 4, articulo_nombre: 'Et X', tipo_item: 'ETIQUETA', enviado: '10' }], rowCount: 1 }],
      [/cant_etiquetas/, { rows: [{ servicio: 'SAUÑE', articulo_id: 4, nombre: 'Et X', consumido: '3' }], rowCount: 1 }],
      [/SELECT id, stock FROM inventario/, { rows: [{ id: 4, stock: '7' }], rowCount: 1 }],
      [/FROM servicios_guias ORDER BY/, { rows: [{ id: 1, numero: 'T009-1' }], rowCount: 1 }],
      [/tipo_doc = 'CONTROL'/, { rows: [{ servicio: 'SAUÑE', n: 2 }], rowCount: 1 }],
      [/factura_estado = 'PENDIENTE'/, { rows: [{ servicio: 'SAUÑE', n: 1 }], rowCount: 1 }]
    ]);
    const res = await invocar('get', '/api/servicios/panel');
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.servicios).toHaveLength(2);
    const saune = res.cuerpo.servicios.find(s => s.servicio === 'SAUÑE');
    expect(saune.insumos[0].saldo).toBe(7);
    expect(res.cuerpo.guias).toHaveLength(1);
  });

  test('controles pendientes exige servicio valido', async () => {
    const res = await invocar('get', '/api/servicios/controles-pendientes', { query: { servicio: 'X' } });
    expect(res.statusCode).toBe(400);
  });
});
