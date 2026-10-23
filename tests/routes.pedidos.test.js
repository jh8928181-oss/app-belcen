/**
 * Pedidos de venta: captura, evaluación en dos niveles (PT + insumos),
 * despacho, consolidado de producción y cancelación.
 *
 * Lo que importa aqui son las reglas que un fallo dejaria dano real:
 *   1. El pedido reparte cada línea entre stock de producto terminado y lo que
 *      falta producir, sin inventar cantidades.
 *   2. Lo que falta producir se valida contra la receta: sin receta no hay
 *      pedido parcial, y los insumos faltantes quedan anotados.
 *   3. El despacho descuenta producto terminado y no deja stock negativo.
 *   4. El consolidado suma varios pedidos del mismo producto en un solo lote.
 *
 * Las rutas viven en index.js y se alcanzan recorriendo la pila del app.
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
  const capa = candidatas.pop();
  return capa.route.stack.map(l => l.handle);
}

async function invocar(method, ruta, req = {}) {
  const res = resFalso();
  const peticion = Object.assign(
    { params: {}, body: {}, query: {}, usuario: 'almacen1', rol: 'almacen', headers: {}, method, originalUrl: ruta },
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

const filas = (...rows) => ({ rows, rowCount: rows.length });

const SQL = {
  ptItem: /FROM producto_terminado WHERE producto_key = \$1/,
  ptForUpdate: /FROM producto_terminado WHERE producto_key = \$1 FOR UPDATE/,
  recetaVigente: /FROM recetas\s+WHERE producto_key = \$1 AND activa/,
  recetaPorId: /FROM recetas WHERE id = \$1/,
  recetaInsumos: /FROM receta_insumos ri/,
  insertPedido: /INSERT INTO pedidos_venta \(/,
  updateNumero: /UPDATE pedidos_venta SET numero_pedido/,
  insertItem: /INSERT INTO pedidos_venta_items/,
  insertInsumo: /INSERT INTO pedidos_venta_insumos/,
  listaPedidos: /SELECT \* FROM pedidos_venta WHERE id = \$1 ORDER BY/,
  listaItemsAny: /SELECT \* FROM pedidos_venta_items WHERE pedido_id = ANY/,
  listaFaltantes: /AND estado = 'FALTANTE'/,
  pedidoForUpdate: /SELECT \* FROM pedidos_venta WHERE id = \$1 FOR UPDATE/,
  itemsDePedido: /SELECT \* FROM pedidos_venta_items WHERE pedido_id = \$1/,
  bajaStock: /UPDATE producto_terminado SET stock_cajas = stock_cajas -/,
  marcaDespachada: /UPDATE pedidos_venta_items SET cantidad_despachada/,
  historial: /INSERT INTO historial_inventario/,
  reevaluar: /SELECT total_despacho, total_produccion/,
  updateEstado: /UPDATE pedidos_venta SET estado = \$1/,
  sumaDespachada: /SELECT COALESCE\(SUM\(cantidad_despachada\)/,
  consolidado: /FROM pedidos_venta_items i\s+JOIN pedidos_venta p ON p\.id = i\.pedido_id/,
  atencionFilas: /SELECT i\.id, i\.pedido_id, i\.cantidad_produccion/,
  marcaProducida: /UPDATE pedidos_venta_items SET cantidad_producida/
};

/** Receta vigente con una sola línea de botella (1 por caja). */
function recetaCon(stockInsumo, porCaja = 1) {
  const base = { id: 500, producto_key: 'belini_1lt', nombre_producto: 'Aceite Belini 1 Lt', version: 1, activa: true };
  const insumo = {
    id: 11,
    receta_id: 500,
    insumo_id: 201,
    nombre_inventario: 'Botella Belini x 1 lt',
    unidad_inventario: 'UNIDADES',
    categoria_inventario: 'BOTELLAS',
    cantidad_por_caja: porCaja,
    cantidad_efectiva: porCaja,
    merma_pct: 0,
    stock_minimo: null,
    obligatorio: true,
    seleccionable: false,
    componente_receta_id: null,
    stock_actual: stockInsumo,
    opciones: []
  };
  return { base, insumos: [insumo] };
}

const crearCuerpo = (extra = {}) => Object.assign({
  fecha_despacho: '2026-10-21',
  solicitante: 'vendedor1',
  vehiculo: 'ABC-123',
  chofer: 'Juan Perez',
  tipo_destino: 'TIENDA',
  direccion: '',
  items: [{ producto_key: 'belini_1lt', cantidad: 10 }]
}, extra);

function sentencias() {
  return mockQuery.mock.calls
    .map(c => String(c[0]).trim())
    .filter(s => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s));
}

function transacciones() {
  return mockQuery.mock.calls
    .map(c => String(c[0]).trim().toUpperCase())
    .filter(s => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s));
}

beforeEach(() => mockQuery.mockReset());

describe('POST /api/pedidos/crear validaciones', () => {
  test('rechaza un tipo de destino fuera del catalogo', async () => {
    responder([]);
    const r = await invocar('post', '/api/pedidos/crear', { body: crearCuerpo({ tipo_destino: 'MARTE' }) });
    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toMatch(/destino/i);
    expect(transacciones()).toHaveLength(0);
  });

  test('la dirección es obligatoria en REPARTO y en PROVINCIA', async () => {
    responder([]);
    const reparto = await invocar('post', '/api/pedidos/crear', { body: crearCuerpo({ tipo_destino: 'REPARTO', direccion: '' }) });
    expect(reparto.statusCode).toBe(400);
    expect(reparto.cuerpo.mensaje).toMatch(/dirección/i);
    const provincia = await invocar('post', '/api/pedidos/crear', { body: crearCuerpo({ tipo_destino: 'PROVINCIA', direccion: '   ' }) });
    expect(provincia.statusCode).toBe(400);
    expect(transacciones()).toHaveLength(0);
  });

  test('un pedido sin productos no pasa de la puerta', async () => {
    responder([]);
    const r = await invocar('post', '/api/pedidos/crear', { body: crearCuerpo({ items: [] }) });
    expect(r.statusCode).toBe(400);
    expect(transacciones()).toHaveLength(0);
  });
});

describe('POST /api/pedidos/crear evaluación', () => {
  test('con stock completo el pedido queda PARA_DESPACHO y no toca insumos', async () => {
    responder([
      [SQL.ptItem, filas({ producto_key: 'belini_1lt', nombre_producto: 'Aceite Belini 1 Lt', stock_cajas: 50 })],
      [SQL.recetaVigente, filas()],
      [SQL.insertPedido, filas({ id: 41 })],
      [SQL.listaPedidos, filas({
        id: 41, numero_pedido: 'PED-2026-0041', estado: 'PARA_DESPACHO',
        total_solicitado: 10, total_despacho: 10, total_produccion: 0
      })],
      [SQL.listaItemsAny, filas({
        pedido_id: 41, producto_key: 'belini_1lt', nombre_producto: 'Aceite Belini 1 Lt',
        cantidad_solicitada: 10, cantidad_despacho: 10, cantidad_produccion: 0
      })],
      [SQL.listaFaltantes, filas()]
    ]);
    const r = await invocar('post', '/api/pedidos/crear', { body: crearCuerpo() });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.pedido.estado).toBe('PARA_DESPACHO');
    expect(r.cuerpo.pedido.total_despacho).toBe(10);
    expect(r.cuerpo.pedido.total_produccion).toBe(0);
    const insertItem = mockQuery.mock.calls.map(c => String(c[0])).find(s => /INSERT INTO pedidos_venta_items/.test(s));
    expect(insertItem).toBeTruthy();
    const paramsItem = mockQuery.mock.calls.find(c => /INSERT INTO pedidos_venta_items/.test(String(c[0])))[1];
    expect(paramsItem.slice(3)).toEqual([10, 10, 0]);
    expect(sentencias().filter(s => /INSERT INTO pedidos_venta_insumos/.test(s))).toHaveLength(0);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('sin stock completo y sin receta el pedido no se registra', async () => {
    responder([
      [SQL.ptItem, filas({ producto_key: 'belini_1lt', nombre_producto: 'Aceite Belini 1 Lt', stock_cajas: 30 })],
      [SQL.recetaVigente, filas()]
    ]);
    const r = await invocar('post', '/api/pedidos/crear', {
      body: crearCuerpo({ items: [{ producto_key: 'belini_1lt', cantidad: 100 }] })
    });
    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toMatch(/receta/i);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('stock parcial con insumos completos: EN_PRODUCCION con el reparto correcto', async () => {
    const { base, insumos } = recetaCon(1000);
    responder([
      [SQL.ptItem, filas({ producto_key: 'belini_1lt', nombre_producto: 'Aceite Belini 1 Lt', stock_cajas: 30 })],
      [SQL.recetaVigente, filas(base)],
      [SQL.recetaPorId, filas(base)],
      [SQL.recetaInsumos, filas(...insumos)],
      [SQL.insertPedido, filas({ id: 42 })],
      [SQL.listaPedidos, filas({
        id: 42, numero_pedido: 'PED-2026-0042', estado: 'EN_PRODUCCION',
        total_solicitado: 100, total_despacho: 30, total_produccion: 70
      })],
      [SQL.listaItemsAny, filas()],
      [SQL.listaFaltantes, filas()]
    ]);
    const r = await invocar('post', '/api/pedidos/crear', {
      body: crearCuerpo({ items: [{ producto_key: 'belini_1lt', cantidad: 100 }] })
    });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.pedido.estado).toBe('EN_PRODUCCION');
    expect(r.cuerpo.pedido.total_despacho).toBe(30);
    expect(r.cuerpo.pedido.total_produccion).toBe(70);
    const paramsItem = mockQuery.mock.calls.find(c => /INSERT INTO pedidos_venta_items/.test(String(c[0])))[1];
    expect(paramsItem.slice(3)).toEqual([100, 30, 70]);
    const paramsInsumo = mockQuery.mock.calls.find(c => /INSERT INTO pedidos_venta_insumos/.test(String(c[0])))[1];
    expect(paramsInsumo[3]).toBe('Botella Belini x 1 lt');
    expect(paramsInsumo[4]).toBe(70);
    expect(paramsInsumo[7]).toBe('OK');
  });

  test('insumos insuficientes: INSUMOS_FALTANTES con el faltante exacto', async () => {
    const { base, insumos } = recetaCon(10);
    responder([
      [SQL.ptItem, filas({ producto_key: 'belini_1lt', nombre_producto: 'Aceite Belini 1 Lt', stock_cajas: 30 })],
      [SQL.recetaVigente, filas(base)],
      [SQL.recetaPorId, filas(base)],
      [SQL.recetaInsumos, filas(...insumos)],
      [SQL.insertPedido, filas({ id: 43 })],
      [SQL.listaPedidos, filas({
        id: 43, numero_pedido: 'PED-2026-0043', estado: 'INSUMOS_FALTANTES',
        total_solicitado: 100, total_despacho: 30, total_produccion: 70
      })],
      [SQL.listaItemsAny, filas()],
      [SQL.listaFaltantes, filas({
        pedido_id: 43, nombre_insumo: 'Botella Belini x 1 lt', requerido: 70, disponible: 10, faltante: 60
      })]
    ]);
    const r = await invocar('post', '/api/pedidos/crear', {
      body: crearCuerpo({ items: [{ producto_key: 'belini_1lt', cantidad: 100 }] })
    });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.pedido.estado).toBe('INSUMOS_FALTANTES');
    const paramsInsumo = mockQuery.mock.calls.find(c => /INSERT INTO pedidos_venta_insumos/.test(String(c[0])))[1];
    expect(paramsInsumo[4]).toBe(70);   // requerido
    expect(paramsInsumo[5]).toBe(10);   // disponible
    expect(paramsInsumo[6]).toBe(60);   // faltante
    expect(paramsInsumo[7]).toBe('FALTANTE');
  });
});

describe('POST /api/pedidos/:id/despachar', () => {
  test('descuenta producto terminado, historialea y cierra el pedido', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 7, numero_pedido: 'PED-2026-0007', estado: 'PARA_DESPACHO' })],
      [SQL.itemsDePedido, filas({ id: 71, pedido_id: 7, producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', cantidad_despacho: 50, cantidad_despachada: 0 })],
      [SQL.ptForUpdate, filas({ nombre_producto: 'Belini 1 Lt', stock_cajas: 60 })],
      [SQL.reevaluar, filas({ total_despacho: 50, total_produccion: 0, despachada: 50, producida: 0 })]
    ]);
    const r = await invocar('post', '/api/pedidos/7/despachar', { params: { id: '7' } });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.estado).toBe('DESPACHADO');
    expect(r.cuerpo.despachados).toEqual([{ producto_key: 'belini_1lt', nombre: 'Belini 1 Lt', cajas: 50 }]);
    expect(sentencias().filter(s => /UPDATE producto_terminado SET stock_cajas = stock_cajas -/.test(s))).toHaveLength(1);
    const paramsBaja = mockQuery.mock.calls.find(c => /stock_cajas = stock_cajas -/.test(String(c[0])))[1];
    expect(paramsBaja).toEqual([50, 'belini_1lt']);
    expect(sentencias().filter(s => /INSERT INTO historial_inventario/.test(s))).toHaveLength(1);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('si el stock no alcanza no se descuenta nada y se avisa', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 7, numero_pedido: 'PED-2026-0007', estado: 'PARA_DESPACHO' })],
      [SQL.itemsDePedido, filas({ id: 71, pedido_id: 7, producto_key: 'belini_1lt', cantidad_despacho: 50, cantidad_despachada: 0 })],
      [SQL.ptForUpdate, filas({ nombre_producto: 'Belini 1 Lt', stock_cajas: 10 })]
    ]);
    const r = await invocar('post', '/api/pedidos/7/despachar', { params: { id: '7' } });
    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toMatch(/insuficiente/i);
    expect(sentencias().filter(s => /stock_cajas = stock_cajas -/.test(s))).toHaveLength(0);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

describe('POST /api/pedidos/:id/cancelar', () => {
  test('un pedido con cajas despachadas no se puede cancelar', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 9, numero_pedido: 'PED-2026-0009', estado: 'EN_PRODUCCION' })],
      [SQL.sumaDespachada, filas({ n: 15 })]
    ]);
    const r = await invocar('post', '/api/pedidos/9/cancelar', { params: { id: '9' } });
    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toMatch(/despachadas/i);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

describe('GET /api/pedidos/consolidado-produccion', () => {
  test('suma las cajas pendientes del mismo producto en un solo lote', async () => {
    responder([
      [SQL.consolidado, filas(
        { producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', total_pendiente: 170, pedidos: 5 },
        { producto_key: 'b1_1lt', nombre_producto: 'B-1 1 Lt', total_pendiente: 40, pedidos: 1 }
      )]
    ]);
    const r = await invocar('get', '/api/pedidos/consolidado-produccion');
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.consolidado).toHaveLength(2);
    expect(r.cuerpo.consolidado[0]).toMatchObject({ producto_key: 'belini_1lt', total_pendiente: 170, pedidos: 5 });
  });
});

describe('POST /api/pedidos/atender-produccion', () => {
  test('reparte las cajas contra los pedidos pendientes en orden', async () => {
    responder([
      [SQL.atencionFilas, filas(
        { id: 91, pedido_id: 5, cantidad_produccion: 80, cantidad_producida: 20, numero_pedido: 'PED-2026-0005', estado: 'EN_PRODUCCION' },
        { id: 92, pedido_id: 8, cantidad_produccion: 30, cantidad_producida: 0, numero_pedido: 'PED-2026-0008', estado: 'EN_PRODUCCION' }
      )],
      [SQL.reevaluar, filas({ total_despacho: 30, total_produccion: 80, despachada: 30, producida: 80 })]
    ]);
    const r = await invocar('post', '/api/pedidos/atender-produccion', {
      body: { producto_key: 'belini_1lt', cajas: 100 }
    });
    expect(r.statusCode).toBe(200);
    // 60 para el pedido 5 (pendiente real: 80-20) y 30 para el 8: 10 en el aire.
    expect(r.cuerpo.atendidos).toEqual([
      { numero_pedido: 'PED-2026-0005', cajas: 60 },
      { numero_pedido: 'PED-2026-0008', cajas: 30 }
    ]);
    expect(r.cuerpo.sin_destino).toBe(10);
    const updates = mockQuery.mock.calls
      .map(c => String(c[0]))
      .filter(s => /UPDATE pedidos_venta_items SET cantidad_producida/.test(s));
    expect(updates).toHaveLength(2);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('cantidad no valida ni siquiera abre transaccion', async () => {
    responder([]);
    const r = await invocar('post', '/api/pedidos/atender-produccion', { body: { producto_key: 'belini_1lt', cajas: 0 } });
    expect(r.statusCode).toBe(400);
    expect(transacciones()).toHaveLength(0);
  });
});
