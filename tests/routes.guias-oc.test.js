/**
 * Tests de la OC dentro de la guia: inventario propio de proveedor por
 * categoria, descuento contra la orden y avisos de guias sin OC.
 *
 * Lo que importa aqui son tres reglas que un fallo dejaria dano real en los
 * inventarios:
 *   1. Una guia sin N° de OC no descuenta el stock de proveedores. Antes lo
 *      restaba a ciegas y el inventario propio del proveedor se descalzaba sin
 *      saber de que orden venia.
 *   2. Cuando la OC si se declara, la cantidad se abona contra una orden del
 *      MISMO proveedor: descontarle la guia de otro proveedor descuadra dos
 *      inventarios a la vez. Y al completarse los items la orden pasa a
 *      COMPLETADA, que es el estado que dispara el resto del flujo.
 *   3. Una factura anulada no cuenta como factura de la orden, o la etiqueta
 *      SIN FACTURA avisaria de una orden que ya la tiene.
 *
 * Las rutas viven en index.js, no en un router aparte, asi que se alcanzan por el
 * app exportado recorriendo su pila, igual que en tests/routes.bd-precios.test.js.
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
  const capa = candidatas.pop();
  return capa.route.stack.map(l => l.handle);
}

/** Recorre las capas de la ruta en orden: si el guard contesta, el handler no corre. */
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

/** Enruta cada consulta por su SQL: contar posiciones se rompe al sumar validaciones. */
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
  // buscarOrdenParaGuia: un unico patron para la lectura de la orden.
  ordenParaGuia: /FROM ordenes_compras_servicios o\s+LEFT JOIN proveedores p ON p\.id = o\.proveedor_id\s+WHERE UPPER\(BTRIM\(o\.numero\)\)/,
  // El resumen que devuelve POST /api/almacen/guia-orden/validar.
  resumenOrden: /SELECT COUNT\(\*\)::int AS n_items,\s+COALESCE\(SUM\(cantidad\), 0\) AS total_cantidad/,
  itemsDeOrden: /SELECT \* FROM ordenes_items WHERE orden_id = \$1/,
  itemsDeOrdenRecibido: /SELECT cantidad, recibido FROM ordenes_items WHERE orden_id = \$1/,
  filaDeGuia: /SELECT \* FROM registro_ingresos_almacen WHERE id = \$1/,
  updateItemRecibido: /UPDATE ordenes_items SET recibido =/,
  updateEstadoOrden: /UPDATE ordenes_compras_servicios SET estado = \$1 WHERE id = \$2/,
  updateFilaAsociada: /UPDATE registro_ingresos_almacen SET orden_id =/,
  updateCabeceraGuia: /UPDATE ingresos_vigilancia/,
  updateRevisada: /UPDATE registro_ingresos_almacen SET asociacion = 'REVISADA'/,
  listaSinOc: /FROM registro_ingresos_almacen\s+WHERE asociacion = 'SIN_OC'\s+ORDER BY/,
  conteoSinOc: /SELECT COUNT\(\*\)::int AS total FROM registro_ingresos_almacen/,
  categoriaProveedor: /SELECT categoria FROM proveedores/,
  stockExiste: /SELECT id, stock FROM stock_proveedores/,
  stockUpdate: /UPDATE stock_proveedores\s+SET stock =/,
  stockInsert: /INSERT INTO stock_proveedores\s*\(proveedor_nombre/,
  historialStock: /INSERT INTO stock_proveedores_historial/,
  insertIngreso: /INSERT INTO ingresos_vigilancia/,
  inventarioExiste: /SELECT id, stock FROM inventario/,
  insertRegistro: /INSERT INTO registro_ingresos_almacen/,
  listaOrdenes: /AS n_facturas/
};

const filas = (...rows) => ({ rows, rowCount: rows.length });

function transacciones() {
  return mockQuery.mock.calls
    .map(c => String(c[0]).trim().toUpperCase())
    .filter(s => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s));
}

function sentencias() {
  return mockQuery.mock.calls
    .map(c => String(c[0]).trim())
    .filter(s => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s));
}

function paramsDe(patron) {
  const llamada = mockQuery.mock.calls.find(c => patron.test(String(c[0])));
  return llamada ? llamada[1] : undefined;
}

const PROVEEDOR = 'CEMENTOS DEL SUR';
const OTRA_EMPRESA = 'PETROLEOS DEL PACIFICO';

const ORDEN = {
  id: 7,
  numero: 'OC-001',
  tipo: 'OC',
  estado: 'EMITIDA',
  proveedor_id: 3,
  proveedor_nombre: PROVEEDOR
};

const ITEM = { id: 11, descripcion: 'CEMENTO CP40', cantidad: 100, recibido: 0, unidad: 'BOLSA' };

const FILA = {
  id: 55,
  fecha_registro: '2026-10-01',
  numero_guia: 'G-001',
  proveedor: PROVEEDOR,
  producto_nombre: 'CEMENTO CP40',
  cantidad: 100,
  unidad_medida: 'BOLSA',
  asociacion: 'SIN_OC',
  estado: 'CONFORME'
};

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

// ---------------------------------------------------------------------------
// POST /api/almacen/guia-orden/validar
// ---------------------------------------------------------------------------
describe('POST /api/almacen/guia-orden/validar', () => {
  test('la orden del proveedor declarado se verifica y trae sus totales', async () => {
    responder([
      [SQL.ordenParaGuia, filas(ORDEN)],
      [SQL.resumenOrden, filas({ n_items: 2, total_cantidad: 150, total_recibido: 0 })]
    ]);

    const r = await invocar('post', '/api/almacen/guia-orden/validar', {
      body: { numero_oc: 'OC-001', proveedor: PROVEEDOR }
    });

    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.orden).toMatchObject({ id: 7, numero: 'OC-001', n_items: 2, total_cantidad: 150 });
  });

  test('no acepta una orden de otro proveedor', async () => {
    responder([[SQL.ordenParaGuia, filas(ORDEN)]]);

    const r = await invocar('post', '/api/almacen/guia-orden/validar', {
      body: { numero_oc: 'OC-001', proveedor: OTRA_EMPRESA }
    });

    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toContain(PROVEEDOR);
    // Nada de la orden se lee ni se escribe si el proveedor no coincide.
    expect(sentencias().some(s => /FROM ordenes_items/.test(s))).toBe(false);
  });

  test('sin numero de orden ni siquiera consulta', async () => {
    responder([[SQL.ordenParaGuia, filas(ORDEN)]]);

    const r = await invocar('post', '/api/almacen/guia-orden/validar', {
      body: { numero_oc: '   ', proveedor: PROVEEDOR }
    });

    expect(r.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('una orden cancelada no puede recibir mercaderia', async () => {
    responder([[SQL.ordenParaGuia, filas({ ...ORDEN, estado: 'CANCELADA' })]]);

    const r = await invocar('post', '/api/almacen/guia-orden/validar', {
      body: { numero_oc: 'OC-001', proveedor: PROVEEDOR }
    });

    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toContain('cancelada');
  });
});

// ---------------------------------------------------------------------------
// POST /api/bd/guias-sin-oc/:id/asociar
// ---------------------------------------------------------------------------
describe('POST /api/bd/guias-sin-oc/:id/asociar', () => {
  const ruta = '/api/bd/guias-sin-oc/55/asociar';
  // La pila se recorre a mano, asi que el id del segmento viaja en params a mano.
  const peticion = (body) => ({ params: { id: '55' }, body });

  function escenario(fila = FILA, orden = ORDEN) {
    responder([
      [SQL.filaDeGuia, filas(fila)],
      [SQL.ordenParaGuia, filas(orden)],
      [SQL.itemsDeOrden, filas({ ...ITEM })],
      [SQL.itemsDeOrdenRecibido, filas({ cantidad: 100, recibido: 100 })],
      [SQL.categoriaProveedor, filas({ categoria: 'Construccion' })],
      [SQL.stockExiste, filas({ id: 3, stock: 50 })]
    ]);
  }

  test('abona la guia, deja la fila ASOCIADA y la orden completa pasa a COMPLETADA', async () => {
    escenario();

    const r = await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.estado_orden).toBe('COMPLETADA');
    expect(r.cuerpo.mensaje).toContain('COMPLETADA');
    // Se recibio el total del item: 100 de los 100 pendientes.
    expect(paramsDe(SQL.updateItemRecibido)).toEqual([100, 11]);
    // Y la fila quedo ligada a la orden, no suelta.
    expect(paramsDe(SQL.updateFilaAsociada)).toEqual([7, 11, 55]);
    expect(paramsDe(SQL.updateEstadoOrden)).toEqual(['COMPLETADA', 7]);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('el descuento del inventario propio lleva el numero de la orden', async () => {
    escenario();

    await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    const stock = paramsDe(SQL.stockUpdate);
    // 50 en stock menos los 100 que llegaron: no baja de cero.
    expect(stock[0]).toBe(0);
    expect(stock[4]).toBe('Construccion');
    // historial: tipo, origen, proveedor, producto, unidad, cantidad,
    //            orden_ref, guia_ref, usuario
    const historial = paramsDe(SQL.historialStock);
    expect(historial[0]).toBe('RESTA');
    expect(historial[5]).toBe(100);
    expect(historial[6]).toBe('OC-001');
    expect(historial[7]).toBe('G-001');
  });

  test('una guia de otro proveedor no toca la orden ni su inventario', async () => {
    responder([
      [SQL.filaDeGuia, filas({ ...FILA, proveedor: OTRA_EMPRESA })],
      [SQL.ordenParaGuia, filas(ORDEN)]
    ]);

    const r = await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toContain(PROVEEDOR);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sentencias().some(s => /stock_proveedores|ordenes_items/.test(s))).toBe(false);
  });

  test('una fila ya resuelta ni siquiera busca la orden', async () => {
    responder([[SQL.filaDeGuia, filas({ ...FILA, asociacion: 'ASOCIADA' })]]);

    const r = await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toMatch(/ya fue asociado|revisado/i);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sentencias().some(s => SQL.ordenParaGuia.test(s))).toBe(false);
  });

  test('un id no numerico no abre transaccion', async () => {
    const r = await invocar('post', '/api/bd/guias-sin-oc/abc/asociar', { params: { id: 'abc' }, body: { numero_oc: 'OC-001' } });

    expect(r.statusCode).toBe(400);
    expect(transacciones()).toEqual([]);
    // Ni una consulta, pero la conexion si se devuelve: un 400 no la puede dejar colgada.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('una fila que no existe responde 404 y revierte', async () => {
    responder([[SQL.filaDeGuia, filas()]]);

    const r = await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    expect(r.statusCode).toBe(404);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('si la orden no trae el producto pendiente no se descuenta nada', async () => {
    responder([
      [SQL.filaDeGuia, filas(FILA)],
      [SQL.ordenParaGuia, filas(ORDEN)],
      [SQL.itemsDeOrden, filas({ ...ITEM, descripcion: 'CAL HIDRATADA' })]
    ]);

    const r = await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toContain('CEMENTO CP40');
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sentencias().some(s => /stock_proveedores/.test(s))).toBe(false);
  });

  test('una orden cancelada no recibe mercaderia', async () => {
    responder([
      [SQL.filaDeGuia, filas(FILA)],
      [SQL.ordenParaGuia, filas({ ...ORDEN, estado: 'CANCELADA' })]
    ]);

    const r = await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toContain('cancelada');
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('el estado de la orden recien emitida no se salta a RECIBIDA', async () => {
    responder([
      [SQL.filaDeGuia, filas({ ...FILA, cantidad: 40 })],
      [SQL.ordenParaGuia, filas(ORDEN)],
      [SQL.itemsDeOrden, filas({ ...ITEM })],
      [SQL.itemsDeOrdenRecibido, filas({ cantidad: 100, recibido: 40 })],
      [SQL.categoriaProveedor, filas({ categoria: 'Construccion' })],
      [SQL.stockExiste, filas({ id: 3, stock: 500 })]
    ]);

    const r = await invocar('post', ruta, peticion({ numero_oc: 'OC-001' }));

    expect(r.statusCode).toBe(200);
    // 40 de 100: avanzo pero no llego, asi que queda RECIBIDA y nunca COMPLETADA.
    expect(paramsDe(SQL.updateItemRecibido)).toEqual([40, 11]);
    expect(r.cuerpo.estado_orden).toBe('RECIBIDA');
    expect(sentencias().some(s => /SET estado = 'COMPLETADA'/.test(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bd/guias-sin-oc
// ---------------------------------------------------------------------------
describe('GET /api/bd/guias-sin-oc', () => {
  test('trae solo las filas pendientes con su total', async () => {
    responder([
      [SQL.listaSinOc, filas({ ...FILA }, { ...FILA, id: 56, producto_nombre: 'ARENADA' })],
      [SQL.conteoSinOc, filas({ total: 2 })]
    ]);

    const r = await invocar('get', '/api/bd/guias-sin-oc');

    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.total).toBe(2);
    expect(r.cuerpo.pendientes).toHaveLength(2);
    expect(sentencias().every(s => /asociacion = 'SIN_OC'/.test(s))).toBe(true);
  });

  test('el listado esta reservado a Base de Datos General', async () => {
    responder([[SQL.listaSinOc, filas()]]);

    const r = await invocar('get', '/api/bd/guias-sin-oc', { rol: 'invitado' });

    expect(r.statusCode).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/bd/guias-sin-oc/:id/revisar
// ---------------------------------------------------------------------------
describe('POST /api/bd/guias-sin-oc/:id/revisar', () => {
  test('marca revisada solo si estaba pendiente', async () => {
    responder([[SQL.updateRevisada, filas({ id: 55 })]]);

    const r = await invocar('post', '/api/bd/guias-sin-oc/55/revisar', { params: { id: '55' } });

    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.mensaje).toContain('revisado');
    expect(paramsDe(SQL.updateRevisada)).toEqual([55]);
  });

  test('una fila que ya no esta pendiente no se puede revisar', async () => {
    responder([[SQL.updateRevisada, filas()]]);

    const r = await invocar('post', '/api/bd/guias-sin-oc/55/revisar', { params: { id: '55' } });

    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toContain('pendiente');
  });

  test('un id no numerico no escribe', async () => {
    const r = await invocar('post', '/api/bd/guias-sin-oc/x/revisar', { params: { id: 'x' } });

    expect(r.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/almacen/registrar-conforme
// ---------------------------------------------------------------------------
describe('POST /api/almacen/registrar-conforme', () => {
  const cuerpo = {
    tipo_documento: 'GUIA DE REMISION',
    numero_guia: 'G-777',
    proveedor: PROVEEDOR,
    items_json: JSON.stringify([{ nombre: 'CEMENTO CP40', cantidad_guia: 100, cantidad_fisica: 100 }])
  };

  const escenarioConformidad = () => responder([
    [SQL.ordenParaGuia, filas(ORDEN)],
    [SQL.insertIngreso, filas({ id: 400, numero_guia: 'G-777' })],
    [SQL.inventarioExiste, filas({ id: 31, stock: 5 })],
    [SQL.insertRegistro, filas({ id: 555 })],
    [SQL.itemsDeOrden, filas({ ...ITEM })],
    [SQL.itemsDeOrdenRecibido, filas({ cantidad: 100, recibido: 100 })],
    [SQL.categoriaProveedor, filas({ categoria: 'Construccion' })],
    [SQL.stockExiste, filas({ id: 3, stock: 50 })]
  ]);

  test('una guia sin OC no descuenta el inventario de los proveedores', async () => {
    responder([
      [SQL.insertIngreso, filas({ id: 400, numero_guia: 'G-777' })],
      [SQL.inventarioExiste, filas({ id: 31, stock: 5 })],
      [SQL.insertRegistro, filas({ id: 555 })]
    ]);

    const r = await invocar('post', '/api/almacen/registrar-conforme', {
      body: { ...cuerpo, numero_oc: '' }
    });

    expect(r.statusCode).toBe(200);
    // La regla que protege los inventarios: nada de stock_proveedores.
    expect(sentencias().some(s => /stock_proveedores/.test(s))).toBe(false);
    expect(sentencias().some(s => /ordenes_items/.test(s))).toBe(false);
    // La fila queda SIN_OC para que aparezca en Notificaciones.
    expect(sentencias().find(s => /INSERT INTO registro_ingresos_almacen/.test(s))).toMatch(/'SIN_OC'/);
    expect(paramsDe(SQL.insertRegistro)[0]).toBe('G-777');
    expect(r.cuerpo.mensaje).toContain('Notificaciones');
    expect(r.cuerpo.asociados).toBe(0);
  });

  test('con OC declarada se abona contra la orden y se la marca', async () => {
    escenarioConformidad();

    const r = await invocar('post', '/api/almacen/registrar-conforme', {
      body: { ...cuerpo, numero_oc: 'OC-001' }
    });

    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.asociados).toBe(1);
    expect(paramsDe(SQL.updateItemRecibido)).toEqual([100, 11]);
    expect(paramsDe(SQL.updateEstadoOrden)).toEqual(['COMPLETADA', 7]);
    // El inventario propio del proveedor si se descuenta, con su OC de referencia.
    expect(paramsDe(SQL.historialStock)[6]).toBe('OC-001');
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('una OC que no es del proveedor de la guia ni deja registrarla', async () => {
    responder([[SQL.ordenParaGuia, filas(ORDEN)]]);

    const r = await invocar('post', '/api/almacen/registrar-conforme', {
      body: { ...cuerpo, numero_oc: 'OC-001', proveedor: OTRA_EMPRESA }
    });

    expect(r.statusCode).toBe(400);
    expect(transacciones()).toEqual([]);
    expect(sentencias().some(s => /INSERT INTO ingresos_vigilancia/.test(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/bd/ordenes: la etiqueta SIN FACTURA
// ---------------------------------------------------------------------------
describe('GET /api/bd/ordenes', () => {
  test('la lista trae n_facturas y no cuenta las anuladas', async () => {
    responder([[SQL.listaOrdenes, filas({ id: 1, n_facturas: 0 })]]);

    const r = await invocar('get', '/api/bd/ordenes');

    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.ordenes[0].n_facturas).toBe(0);

    const consulta = sentencias().find(s => SQL.listaOrdenes.test(s));
    expect(consulta).toMatch(/estado <> 'ANULADA'/);
  });
});
