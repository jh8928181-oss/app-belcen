/**
 * Pedidos de venta: captura, evaluación en dos niveles (PT + insumos),
 * despacho, consolidado de producción y cancelación.
 *
 * Lo que importa aqui son las reglas que un fallo dejaria dano real:
 *   1. El pedido reparte cada línea entre stock de producto terminado y lo que
 *      falta producir, sin inventar cantidades.
 *   2. Lo que falta producir se valida contra la receta: sin receta no hay
 *      pedido parcial, y los insumos faltantes quedan anotados.
 *   3. El despacho descuenta producto terminado, no deja stock negativo y
 *      registra la salida en salidas_almacen (protocolo de almacén: cada
 *      despacho de pedido aparece en la pestaña Salidas, con guía o quede
 *      PENDIENTE REGULARIZAR).
 *   4. El consolidado suma varios pedidos del mismo producto en un solo lote.
 *   5. Una salida del formulario de Almacén con pedido_id (protocolo de
 *      salidas con órdenes): valida contra la orden —todo producto debe estar
 *      en ella y no exceder lo pendiente— y descuenta pedidos_venta_items en
 *      la misma transacción que descuenta stock.
 *   6. Pedidos completados se arma sola desde lo que almacén despachó:
 *      pedido, producto, cantidad, guía y carro salen de la salida registrada.
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
  // Express evalúa en orden de registro y la ruta estática gana sobre /:id;
  // aqui se replica eligiendo la exacta cuando existe.
  const exactas = candidatas.filter(c => !c.route.path.split('/').some(seg => seg.startsWith(':')));
  const capa = (exactas.length ? exactas : candidatas).pop();
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
  insertSalida: /INSERT INTO salidas_almacen/,
  reevaluar: /SELECT total_despacho, total_produccion/,
  updateEstado: /UPDATE pedidos_venta SET estado = \$1/,
  sumaDespachada: /SELECT COALESCE\(SUM\(cantidad_despachada\)/,
  consolidado: /FROM pedidos_venta_items i\s+JOIN pedidos_venta p ON p\.id = i\.pedido_id/,
  atencionFilas: /SELECT i\.id, i\.pedido_id, i\.cantidad_produccion/,
  marcaProducida: /UPDATE pedidos_venta_items SET cantidad_producida/,
  despachadosCab: /SELECT p\.id, p\.numero_pedido, p\.estado/,
  despachadosItems: /SELECT pedido_id, nombre_producto, cantidad_despachada\s+FROM pedidos_venta_items/
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
    // Sin faltantes no hay aviso de cobertura.
    expect(r.cuerpo.advertencia).toBe(false);
    expect(r.cuerpo.cobertura).toEqual([]);
    expect(r.cuerpo.mensaje).not.toMatch(/Faltan insumos/);
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
    // El aviso dice cuántas cajas alcanza a producir el stock disponible:
    // hay 10 botellas y la receta lleva 1 por caja, sobre 70 cajas a producir.
    expect(r.cuerpo.advertencia).toBe(true);
    expect(r.cuerpo.mensaje).toMatch(/Faltan insumos/);
    expect(r.cuerpo.mensaje).toMatch(/alcanza para producir 10 de 70 cajas de «Aceite Belini 1 Lt»/);
    expect(r.cuerpo.cobertura).toHaveLength(1);
    expect(r.cuerpo.cobertura[0].cajas_solicitadas).toBe(70);
    expect(r.cuerpo.cobertura[0].cajas_posibles).toBe(10);
    expect(r.cuerpo.cobertura[0].faltantes[0].nombre).toBe('Botella Belini x 1 lt');
    expect(r.cuerpo.cobertura[0].faltantes[0].faltante).toBe(60);
  });

  test('el cuello de botella manda: con dos insumos se toma el mínimo de cajas posibles', async () => {
    const { base, insumos } = recetaCon(100);            // botellas: alcanzan 100 cajas
    insumos.push({
      ...insumos[0],
      id: 12, insumo_id: 202, nombre_inventario: 'Tapa Belini', categoria_inventario: 'TAPAS',
      stock_actual: 65                                    // tapas: solo alcanzan 65 cajas
    });
    responder([
      [SQL.ptItem, filas({ producto_key: 'belini_1lt', nombre_producto: 'Aceite Belini 1 Lt', stock_cajas: 0 })],
      [SQL.recetaVigente, filas(base)],
      [SQL.recetaPorId, filas(base)],
      [SQL.recetaInsumos, filas(...insumos)],
      [SQL.insertPedido, filas({ id: 44 })],
      [SQL.listaPedidos, filas({
        id: 44, numero_pedido: 'PED-2026-0044', estado: 'INSUMOS_FALTANTES',
        total_solicitado: 100, total_despacho: 0, total_produccion: 100
      })],
      [SQL.listaItemsAny, filas()],
      [SQL.listaFaltantes, filas()]
    ]);
    const r = await invocar('post', '/api/pedidos/crear', {
      body: crearCuerpo({ items: [{ producto_key: 'belini_1lt', cantidad: 100 }] })
    });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.advertencia).toBe(true);
    expect(r.cuerpo.cobertura).toHaveLength(1);
    expect(r.cuerpo.cobertura[0].cajas_posibles).toBe(65);   // min(100 botellas, 65 tapas)
    expect(r.cuerpo.cobertura[0].faltantes.map(f => f.nombre)).toEqual(['Tapa Belini']);
    expect(r.cuerpo.mensaje).toMatch(/alcanza para producir 65 de 100 cajas/);
  });
});

describe('POST /api/pedidos/:id/despachar', () => {
  test('descuenta producto terminado, historialea, registra la salida en almacén y cierra el pedido', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 7, numero_pedido: 'PED-2026-0007', estado: 'PARA_DESPACHO', tipo_destino: 'TIENDA', direccion: 'Av. Principal 123', chofer: 'Juan Pérez', vehiculo: 'ABC-123' })],
      [SQL.itemsDePedido, filas({ id: 71, pedido_id: 7, producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', cantidad_despacho: 50, cantidad_despachada: 0 })],
      [SQL.ptForUpdate, filas({ nombre_producto: 'Belini 1 Lt', stock_cajas: 60 })],
      [SQL.reevaluar, filas({ total_despacho: 50, total_produccion: 0, despachada: 50, producida: 0 })]
    ]);
    const r = await invocar('post', '/api/pedidos/7/despachar', { params: { id: '7' }, body: { numero_guia: 'G-001' } });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.estado).toBe('DESPACHADO');
    expect(r.cuerpo.despachados).toEqual([{ producto_key: 'belini_1lt', nombre: 'Belini 1 Lt', cajas: 50 }]);
    expect(sentencias().filter(s => /UPDATE producto_terminado SET stock_cajas = stock_cajas -/.test(s))).toHaveLength(1);
    const paramsBaja = mockQuery.mock.calls.find(c => /stock_cajas = stock_cajas -/.test(String(c[0])))[1];
    expect(paramsBaja).toEqual([50, 'belini_1lt']);
    expect(sentencias().filter(s => /INSERT INTO historial_inventario/.test(s))).toHaveLength(1);
    // Protocolo de almacén: el despacho deja su fila en salidas_almacen,
    // vinculada al pedido, con la guía que se envió.
    expect(sentencias().filter(s => /INSERT INTO salidas_almacen/.test(s))).toHaveLength(1);
    const paramsSalida = mockQuery.mock.calls.find(c => /INSERT INTO salidas_almacen/.test(String(c[0])))[1];
    expect(paramsSalida[0]).toBe('CON GUIA');
    expect(paramsSalida[1]).toBe('G-001');
    expect(paramsSalida[2]).toContain('PED-2026-0007');
    expect(paramsSalida[6]).toBe(50);           // cantidad_salida
    expect(paramsSalida[8]).toBe('REGULARIZADO');
    expect(paramsSalida[10]).toBe('belini_1lt');
    expect(paramsSalida[11]).toBe(7);           // pedido_id
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('sin número de guía la salida queda PENDIENTE REGULARIZAR', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 7, numero_pedido: 'PED-2026-0007', estado: 'PARA_DESPACHO', tipo_destino: 'REPARTO' })],
      [SQL.itemsDePedido, filas({ id: 71, pedido_id: 7, producto_key: 'belini_1lt', cantidad_despacho: 20, cantidad_despachada: 0 })],
      [SQL.ptForUpdate, filas({ nombre_producto: 'Belini 1 Lt', stock_cajas: 30 })],
      [SQL.reevaluar, filas({ total_despacho: 20, total_produccion: 0, despachada: 20, producida: 0 })]
    ]);
    const r = await invocar('post', '/api/pedidos/7/despachar', { params: { id: '7' }, body: { numero_guia: '' } });
    expect(r.statusCode).toBe(200);
    const paramsSalida = mockQuery.mock.calls.find(c => /INSERT INTO salidas_almacen/.test(String(c[0])))[1];
    expect(paramsSalida[0]).toBe('SIN GUIA');
    expect(paramsSalida[1]).toBe('S/N');
    expect(paramsSalida[8]).toBe('PENDIENTE REGULARIZAR');
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
    expect(sentencias().filter(s => /INSERT INTO salidas_almacen/.test(s))).toHaveLength(0);
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
    // Cada caja cubierta sube tambien cantidad_despacho: ya esta en almacén
    // y pasa a ser despachable (el despacho resta de esa columna).
    updates.forEach(u => expect(u).toContain('cantidad_despacho = cantidad_despacho + $1'));
    // Cubierto todo lo pedido, el pedido sale de EN_PRODUCCION: queda PRODUCIDO.
    const estados = mockQuery.mock.calls
      .map(c => [String(c[0]), c[1]])
      .filter(([s]) => SQL.updateEstado.test(s));
    expect(estados.map(e => e[1])).toEqual([['PRODUCIDO', 5], ['PRODUCIDO', 8]]);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('cantidad no valida ni siquiera abre transaccion', async () => {
    responder([]);
    const r = await invocar('post', '/api/pedidos/atender-produccion', { body: { producto_key: 'belini_1lt', cajas: 0 } });
    expect(r.statusCode).toBe(400);
    expect(transacciones()).toHaveLength(0);
  });
});

describe('GET /api/pedidos/despachados — pedidos completados', () => {
  test('arma la lista sola desde lo que almacén despachó, con la guía', async () => {
    responder([
      [SQL.despachadosCab, filas(
        { id: 41, numero_pedido: 'PED-2026-0041', estado: 'DESPACHADO', numero_guia: 'G-001' },
        { id: 42, numero_pedido: 'PED-2026-0042', estado: 'EN_PRODUCCION', numero_guia: null }
      )],
      [SQL.despachadosItems, filas(
        { pedido_id: 41, nombre_producto: 'Belini 1 Lt', cantidad_despachada: 50 },
        { pedido_id: 42, nombre_producto: 'B-1 1 Lt', cantidad_despachada: 12 }
      )]
    ]);
    const r = await invocar('get', '/api/pedidos/despachados');
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.success).toBe(true);
    expect(r.cuerpo.pedidos).toHaveLength(2);
    // Chofer y placa ya no se piden en Pedidos: la lista no los trae.
    expect(r.cuerpo.pedidos[0]).toMatchObject({ numero_pedido: 'PED-2026-0041', numero_guia: 'G-001' });
    expect(r.cuerpo.pedidos[0].carro).toBeUndefined();
    expect(r.cuerpo.pedidos[0].vehiculo).toBeUndefined();
    expect(r.cuerpo.pedidos[0].items).toHaveLength(1);
    expect(r.cuerpo.pedidos[0].items[0]).toMatchObject({ nombre_producto: 'Belini 1 Lt', cantidad_despachada: 50 });
    // Un pedido despachado a medias (esperando producción) también aparece.
    expect(r.cuerpo.pedidos[1]).toMatchObject({ estado: 'EN_PRODUCCION', numero_guia: null });
    expect(transacciones()).toHaveLength(0);
    expect(sentencias().filter(s => /INSERT|UPDATE|DELETE/i.test(s))).toHaveLength(0);
  });

  test('es lectura pura: sin pedidos no consulta renglones ni escribe', async () => {
    responder([[SQL.despachadosCab, filas()]]);
    const r = await invocar('get', '/api/pedidos/despachados');
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.pedidos).toEqual([]);
    expect(sentencias().filter(s => SQL.despachadosItems.test(s))).toHaveLength(0);
    expect(transacciones()).toHaveLength(0);
  });
});

describe('GET /api/pedidos/lista-despacho — lista de almacén', () => {
  const cabecera = /SELECT p\.id, p\.numero_pedido, p\.estado, p\.solicitante, p\.fecha_despacho/;
  const renglones = /SELECT pedido_id, producto_key, nombre_producto, cantidad_despacho, cantidad_despachada\s+FROM pedidos_venta_items/;

  test('separa por cliente y fecha de despacho, con las cajas que faltan salir', async () => {
    responder([
      [cabecera, filas(
        { id: 6, numero_pedido: 'PED-2026-0006', estado: 'PRODUCIDO', solicitante: 'admin1', fecha_despacho: new Date('2026-11-10T00:00:00Z'), tipo_destino: 'TIENDA', direccion: null, numero_guia: null },
        { id: 7, numero_pedido: 'PED-2026-0007', estado: 'EN_PRODUCCION', solicitante: 'admin1', fecha_despacho: new Date('2026-11-10T00:00:00Z'), tipo_destino: 'REPARTO', direccion: 'Av. Principal 123', numero_guia: 'G-001' },
        { id: 8, numero_pedido: 'PED-2026-0008', estado: 'PARA_DESPACHO', solicitante: 'vendedor2', fecha_despacho: new Date('2026-11-12T00:00:00Z'), tipo_destino: 'TIENDA', direccion: null, numero_guia: null }
      )],
      [renglones, filas(
        { pedido_id: 6, producto_key: 'donlalo_800ml', nombre_producto: 'Don Lalo 800 ml', cantidad_despacho: 800, cantidad_despachada: 0 },
        { pedido_id: 7, producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', cantidad_despacho: 50, cantidad_despachada: 20 },
        { pedido_id: 8, producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', cantidad_despacho: 10, cantidad_despachada: 0 }
      )]
    ]);
    const r = await invocar('get', '/api/pedidos/lista-despacho');
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.success).toBe(true);
    // Dos grupos: admin1 con fecha 10/11 (2 pedidos) y vendedor2 con 12/11.
    expect(r.cuerpo.grupos).toHaveLength(2);
    const g1 = r.cuerpo.grupos[0];
    expect(g1).toMatchObject({ cliente: 'admin1', fecha_despacho: '2026-11-10' });
    expect(g1.pedidos.map(p => p.numero_pedido)).toEqual(['PED-2026-0006', 'PED-2026-0007']);
    // Por despachar = cantidad_despacho - cantidad_despachada.
    expect(g1.pedidos[0].cajas).toBe(800);
    expect(g1.pedidos[0].items[0].pendiente).toBe(800);
    expect(g1.pedidos[1].cajas).toBe(30);
    expect(g1.cajas).toBe(830);
    expect(r.cuerpo.grupos[1]).toMatchObject({ cliente: 'vendedor2', fecha_despacho: '2026-11-12', cajas: 10 });
    expect(r.cuerpo.total_pedidos).toBe(3);
    expect(r.cuerpo.total_cajas).toBe(840);
    // Es lectura pura.
    expect(transacciones()).toHaveLength(0);
    expect(sentencias().filter(s => /INSERT|UPDATE|DELETE/i.test(s))).toHaveLength(0);
  });

  test('sin pedidos por despachar la lista sale vacía, sin renglones', async () => {
    responder([[cabecera, filas()]]);
    const r = await invocar('get', '/api/pedidos/lista-despacho');
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.grupos).toEqual([]);
    expect(r.cuerpo.total_cajas).toBe(0);
    expect(sentencias().filter(s => renglones.test(s))).toHaveLength(0);
    expect(transacciones()).toHaveLength(0);
  });
});

describe('GET /api/pedidos/stock', () => {
  test('devuelve producto terminado e insumos de recetas vigentes', async () => {
    responder([
      [/FROM producto_terminado ORDER BY nombre_producto/, filas(
        { producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', stock_cajas: 518, stock_minimo: 100 },
        { producto_key: 'b1_1lt', nombre_producto: 'B-1 1 Lt', stock_cajas: 902, stock_minimo: null }
      )],
      [/FROM inventario inv\s+WHERE inv\.id IN/, filas(
        { id: 201, nombre: 'Botella Belini x 1 lt', stock: 12000, stock_minimo: 5000, unidad_medida: 'UNIDADES', categoria: 'BOTELLAS' }
      )]
    ]);
    const r = await invocar('get', '/api/pedidos/stock');
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.pt).toHaveLength(2);
    expect(r.cuerpo.pt[0]).toMatchObject({ producto_key: 'belini_1lt', stock_cajas: 518 });
    expect(r.cuerpo.insumos).toHaveLength(1);
    expect(r.cuerpo.insumos[0]).toMatchObject({ id: 201, unidad_medida: 'UNIDADES' });
    // El stock es lectura pura: ni transacción ni escritura.
    expect(transacciones()).toHaveLength(0);
    expect(sentencias().filter(s => /INSERT|UPDATE|DELETE/i.test(s))).toHaveLength(0);
  });
});

describe('POST /api/salidas/registrar (protocolo: salidas con orden de pedido)', () => {
  const stockOk = [
    [/SELECT stock_cajas FROM producto_terminado WHERE producto_key = \$1/, filas({ stock_cajas: 100 })],
    [/SELECT nombre_producto, stock_cajas FROM producto_terminado/, filas({ nombre_producto: 'Belini 1 Lt', stock_cajas: 100 })]
  ];
  const salidaCuerpo = (extra = {}) => Object.assign({
    tipo_registro: 'CON GUIA',
    numero_guia: 'G-778',
    empresa: 'TIENDA',
    items_json: JSON.stringify([{ nombre: 'Belini 1 Lt', cantidad: 10, producto_key: 'belini_1lt' }])
  }, extra);

  test('con pedido_id descuenta stock, anota la salida y baja la orden', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 7, numero_pedido: 'PED-2026-0007', estado: 'PARA_DESPACHO' })],
      [SQL.itemsDePedido, filas({ id: 71, pedido_id: 7, producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', cantidad_despacho: 50, cantidad_despachada: 0 })],
      ...stockOk,
      [SQL.reevaluar, filas({ total_despacho: 50, total_produccion: 0, despachada: 10, producida: 0 })]
    ]);
    const r = await invocar('post', '/api/salidas/registrar', { body: salidaCuerpo({ pedido_id: '7' }) });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.success).toBe(true);
    expect(r.cuerpo.pedido_estado).toBe('PARA_DESPACHO');
    // La salida lleva el pedido en pedido_id (columna 17)
    const paramsSalida = mockQuery.mock.calls.find(c => /INSERT INTO salidas_almacen/.test(String(c[0])))[1];
    expect(paramsSalida).toHaveLength(17);
    expect(paramsSalida[16]).toBe(7);
    // Stock de PT: un solo descuento, y la orden se actualiza en la misma transacción
    const paramsBaja = mockQuery.mock.calls.find(c => /stock_cajas = stock_cajas -/.test(String(c[0])))[1];
    expect(paramsBaja).toEqual([10, 'belini_1lt']);
    const paramsItems = mockQuery.mock.calls.find(c => /cantidad_despachada = cantidad_despachada \+/.test(String(c[0])))[1];
    expect(paramsItems).toEqual([10, 71]);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('un producto que no está en la orden se rechaza sin registrar nada', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 7, numero_pedido: 'PED-2026-0007', estado: 'PARA_DESPACHO' })],
      [SQL.itemsDePedido, filas({ id: 71, pedido_id: 7, producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', cantidad_despacho: 50, cantidad_despachada: 0 })]
    ]);
    const r = await invocar('post', '/api/salidas/registrar', {
      body: salidaCuerpo({ pedido_id: '7', items_json: JSON.stringify([{ nombre: 'Faisan 900 ml', cantidad: 5, producto_key: 'faisan_900ml' }]) })
    });
    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toContain('PED-2026-0007');
    expect(sentencias().filter(s => /INSERT INTO salidas_almacen/.test(s))).toHaveLength(0);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('no deja despachar más de lo que falta en la orden', async () => {
    responder([
      [SQL.pedidoForUpdate, filas({ id: 7, numero_pedido: 'PED-2026-0007', estado: 'EN_PRODUCCION' })],
      [SQL.itemsDePedido, filas({ id: 71, pedido_id: 7, producto_key: 'belini_1lt', nombre_producto: 'Belini 1 Lt', cantidad_despacho: 20, cantidad_despachada: 15 })]
    ]);
    const r = await invocar('post', '/api/salidas/registrar', {
      body: salidaCuerpo({ pedido_id: '7', items_json: JSON.stringify([{ nombre: 'Belini 1 Lt', cantidad: 10, producto_key: 'belini_1lt' }]) })
    });
    expect(r.statusCode).toBe(400);
    expect(r.cuerpo.mensaje).toMatch(/falta despachar 5 caja/);
    expect(sentencias().filter(s => /INSERT INTO salidas_almacen/.test(s))).toHaveLength(0);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('sin pedido_id sigue siendo una salida libre que no toca órdenes', async () => {
    responder(stockOk);
    const r = await invocar('post', '/api/salidas/registrar', { body: salidaCuerpo() });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.pedido_estado).toBeUndefined();
    const paramsSalida = mockQuery.mock.calls.find(c => /INSERT INTO salidas_almacen/.test(String(c[0])))[1];
    expect(paramsSalida[16]).toBeNull();
    expect(sentencias().filter(s => /UPDATE pedidos_venta_items/.test(s))).toHaveLength(0);
    expect(sentencias().filter(s => /FROM pedidos_venta WHERE/.test(s))).toHaveLength(0);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('una cabecera larga se recorta en vez de reventar el INSERT', async () => {
    // La guía se lee con OCR/IA y puede traer texto larguísimo (direcciones,
    // bloques de "Datos del Destinatario"). Antes eso moría en Postgres con
    // "value too long for type character varying(150)" y se perdía el
    // despacho entero; ahora el servidor recorta a los límites de columna.
    responder(stockOk);
    const largo = 'INVERSIONES ZONA NORTE S.A.C. - REGISTRO ÚNICO DE CONTRIBUYENTES '.repeat(20);
    const r = await invocar('post', '/api/salidas/registrar', {
      body: salidaCuerpo({ destino: largo, punto_partida: largo, chofer_licencia: largo })
    });
    expect(r.statusCode).toBe(200);
    expect(r.cuerpo.success).toBe(true);
    const p = mockQuery.mock.calls.find(c => /INSERT INTO salidas_almacen/.test(String(c[0])))[1];
    expect(p[5]).toHaveLength(500);   // destino
    expect(p[6]).toHaveLength(300);   // chofer_licencia
    expect(p[8]).toHaveLength(500);   // punto_partida
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });
});
