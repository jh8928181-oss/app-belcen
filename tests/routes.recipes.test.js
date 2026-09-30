/**
 * Tests de las rutas de recetas: sobre todo las dos reglas que hacen que una
 * receta activa no se pueda pisar por accidente.
 *   1. Editar contenido de una receta activa va SIEMPRE al borrador.
 *   2. Activar sin stock NO activa: responde 409 y espera confirmacion.
 */
const mockQuery = jest.fn();

const SQL_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b|SELECT set_config\(/i;

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (sql, params) => SQL_CONTROL.test(sql) ? Promise.resolve({ rows: [] }) : mockQuery(sql, params),
    release: () => {}
  })
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => next(),
  crearGuardRoles: () => (req, res, next) => next()
}));

// El service se ejerce de verdad: lo que se prueba aqui es la politica de las
// rutas, no el motor de recetas (eso vive en tests/services.recipeService.test.js).
const mockService = {
  obtenerRecetaPorId: jest.fn(),
  obtenerRecetaVigente: jest.fn(),
  listarRecetas: jest.fn(),
  crearReceta: jest.fn(),
  activarReceta: jest.fn(),
  clonarRecetaParaEdicion: jest.fn(),
  calcularInsumosProduccion: jest.fn(),
  calcularInsumosDeReceta: jest.fn(),
  simularImpacto: jest.fn(),
  evaluarCobertura: jest.fn(),
  validarLineas: jest.fn(),
  detectaCiclo: jest.fn(),
  idsInsumosFaltantes: jest.fn(),
  resolverNombresInventario: jest.fn(),
  insertarLineas: jest.fn(),
  diffReceta: jest.fn(),
  nombreDe: r => r.nombre_producto || r.producto_key,
  PROFUNDIDAD_MAXIMA: 5
};

jest.mock('../services/recipeService', () => mockService);

const router = require('../routes/recipes');

function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) { r.cuerpo = cuerpo; return r; }
  };
  return r;
}

/** Busca el handler de un metodo+ruta dentro del router montado. */
function handler(method, ruta) {
  const capa = router.stack.find(l => l.route && l.route.path === ruta && l.route.methods[method]);
  if (!capa) throw new Error(`No existe la ruta ${method.toUpperCase()} ${ruta}`);
  return capa.route.stack[capa.route.stack.length - 1].handle;
}

async function invocar(method, ruta, req) {
  const res = resFalso();
  await handler(method, ruta)(req, res);
  return res;
}

const reqFalso = (params = {}, body = {}, query = {}) => ({
  params, body, query, usuario: 'admin', headers: {}
});

const recetaActiva = over => Object.assign({
  id: 10, producto_key: 'PT-B1', nombre_producto: 'Bidón B1', version: 3,
  activa: true, observaciones: '', created_by: 'admin',
  insumos: [{ insumo_id: 1, componente_receta_id: null, cantidad_por_caja: 2 }]
}, over);

beforeEach(() => {
  mockQuery.mockReset();
  // Por defecto las consultas devuelven "nada", salvo el catalogo de recetas que
  // usa el editor para resolver un componente: ese debe existir siempre.
  mockQuery.mockImplementation(async sql => {
    if (/SELECT producto_key, nombre_producto FROM recetas WHERE id/.test(sql)) {
      return { rows: [{ producto_key: 'PT-SUB', nombre_producto: 'Subensamblaje' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  mockService.obtenerRecetaPorId.mockReset();
  mockService.clonarRecetaParaEdicion.mockReset().mockResolvedValue(
    { id: 11, producto_key: 'PT-B1', nombre_producto: 'Bidón B1', version: 4, activa: false, insumos: [] }
  );
  mockService.crearReceta.mockReset();
  mockService.simularImpacto.mockReset();
  mockService.diffReceta.mockReset();
  mockService.insertarLineas.mockReset().mockResolvedValue(undefined);
  mockService.activarReceta.mockReset();
  mockService.detectaCiclo.mockReset().mockResolvedValue(false);
  mockService.validarLineas.mockReset().mockResolvedValue({ ok: true, errores: [] });
  mockService.idsInsumosFaltantes.mockReset().mockResolvedValue([]);
  mockService.resolverNombresInventario.mockReset().mockResolvedValue(new Map([
    [1, { id: 1, nombre: 'Resina PET', unidad_medida: 'KG', categoria: 'Materia prima', stock: 50 }]
  ]));
});

describe('PUT /:id — la receta activa nunca se pisa', () => {
  test('redirige a un borrador clonado y no escribe sobre la activa', async () => {
    mockService.obtenerRecetaPorId
      .mockResolvedValueOnce(recetaActiva())
      .mockResolvedValueOnce({ id: 11, producto_key: 'PT-B1', version: 4, activa: false, insumos: [] });
    mockService.clonarRecetaParaEdicion.mockResolvedValue({ id: 11, producto_key: 'PT-B1', version: 4, activa: false, insumos: [] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await invocar('put', '/:id', reqFalso({ id: '10' }, {
      insumos: [{ insumo_id: 1, cantidad_por_caja: 2 }]
    }));

    expect(res.statusCode).toBeNull(); // 200 implicito
    expect(res.cuerpo.success).toBe(true);
    expect(res.cuerpo.redirigida_a_borrador).toBe(true);
    expect(mockService.clonarRecetaParaEdicion).toHaveBeenCalledTimes(1);

    // Nadie desactivo ni modifico la receta activa: no debe existir un
    // UPDATE ... SET activa sobre el id 10.
    const updates = mockQuery.mock.calls.filter(([sql]) => /UPDATE recetas SET activa/.test(sql));
    expect(updates).toHaveLength(0);
  });

  test('tampoco se salta la regla con forzar: true', async () => {
    mockService.obtenerRecetaPorId
      .mockResolvedValueOnce(recetaActiva())
      .mockResolvedValueOnce({ id: 11, producto_key: 'PT-B1', version: 4, activa: false, insumos: [] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await invocar('put', '/:id', reqFalso({ id: '10' }, {
      insumos: [{ insumo_id: 1, cantidad_por_caja: 2 }],
      forzar: true
    }));

    expect(res.cuerpo.redirigida_a_borrador).toBe(true);
  });

  test('editar observaciones de la activa tambien va al borrador', async () => {
    mockService.obtenerRecetaPorId
      .mockResolvedValueOnce(recetaActiva())
      .mockResolvedValueOnce({ id: 11, producto_key: 'PT-B1', version: 4, activa: false, insumos: [] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await invocar('put', '/:id', reqFalso({ id: '10' }, { observaciones: 'nueva nota' }));

    expect(res.cuerpo.redirigida_a_borrador).toBe(true);
    const upd = mockQuery.mock.calls.find(([sql]) => /UPDATE recetas SET observaciones/.test(sql));
    expect(upd[1]).toEqual(['nueva nota', 11]);
  });

  test('desactivar NO crea borrador: es una decisión consciente', async () => {
    mockService.obtenerRecetaPorId
      .mockResolvedValue(recetaActiva())
      .mockResolvedValue({ id: 10, producto_key: 'PT-B1', version: 3, activa: false, insumos: [] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await invocar('put', '/:id', reqFalso({ id: '10' }, { activa: false }));

    expect(res.cuerpo.redirigida_a_borrador).toBe(false);
    const upd = mockQuery.mock.calls.find(([sql]) => /SET activa = false/.test(sql));
    expect(upd[1][0]).toBe(10);
  });

  test('un ciclo de componentes se rechaza con 400 y no deja escrituras', async () => {
    mockService.obtenerRecetaPorId.mockResolvedValue(recetaActiva());
    mockService.detectaCiclo.mockResolvedValue(true);

    const res = await invocar('put', '/:id', reqFalso({ id: '10' }, {
      insumos: [{ componente_receta_id: 10, cantidad_por_caja: 1 }]
    }));

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/ciclo/i);
    const borrados = mockQuery.mock.calls.filter(([sql]) => /DELETE FROM receta_insumos/.test(sql));
    expect(borrados).toHaveLength(0);
  });
});

describe('activar sin stock pide confirmación en vez de activar', () => {
  test('PUT /:id/activar responde 409 con requiere_confirmacion', async () => {
    mockService.activarReceta.mockResolvedValue({
      success: false, requiere_confirmacion: true,
      receta: recetaActiva({ activa: false }),
      advertencia: 'Con el stock actual no alcanza para 1 caja(s): Resina PET (stock 0, se piden 2)',
      faltantes: ['Resina PET: requiere 2 | stock: 0'],
      mensaje: 'No se activo: ...'
    });

    const res = await invocar('put', '/:id/activar', reqFalso({ id: '10' }, {}));

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.requiere_confirmacion).toBe(true);
    expect(mockService.activarReceta).toHaveBeenCalledWith('10', 'admin', { forzar: false, cajas: 1 });
  });

  test('PUT /:id/activar con forzar sí activa', async () => {
    mockService.activarReceta.mockResolvedValue({
      success: true, requiere_confirmacion: false,
      receta: recetaActiva(), advertencia: null, mensaje: 'Receta activada correctamente.'
    });

    const res = await invocar('put', '/:id/activar', reqFalso({ id: '10' }, { forzar: true }));

    expect(res.statusCode).toBeNull();
    expect(res.cuerpo.success).toBe(true);
    expect(mockService.activarReceta).toHaveBeenCalledWith('10', 'admin', { forzar: true, cajas: 1 });
  });

  test('guardar y activar devuelve 409 sin dar por activa la receta', async () => {
    mockService.obtenerRecetaPorId.mockResolvedValue(recetaActiva({ activa: false }));
    mockService.activarReceta.mockResolvedValue({
      success: false, requiere_confirmacion: true,
      receta: recetaActiva({ activa: false }),
      advertencia: 'faltan insumos', faltantes: ['x'], mensaje: 'No se activo: faltan insumos'
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await invocar('put', '/:id', reqFalso({ id: '10' }, {
      insumos: [{ insumo_id: 1, cantidad_por_caja: 2 }],
      activar: true
    }));

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.requiere_confirmacion).toBe(true);
    expect(res.cuerpo.mensaje).toMatch(/No se activo/);
    // El service recibio la orden, pero el servidor NO marco la receta como activa.
    expect(mockService.activarReceta).toHaveBeenCalledTimes(1);
  });

  test('guardar y activar ignora un forzar:true del mismo cuerpo', async () => {
    mockService.obtenerRecetaPorId.mockResolvedValue(recetaActiva({ activa: false }));
    mockService.activarReceta.mockResolvedValue({
      success: false, requiere_confirmacion: true,
      receta: recetaActiva({ activa: false }),
      advertencia: 'faltan insumos', faltantes: ['x'], mensaje: 'No se activo: faltan insumos'
    });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await invocar('put', '/:id', reqFalso({ id: '10' }, {
      insumos: [{ insumo_id: 1, cantidad_por_caja: 2 }],
      activar: true,
      forzar: true
    }));

    // Forzar solo existe en PUT /:id/activar: guardar nunca se salta el aviso.
    expect(mockService.activarReceta).toHaveBeenCalledWith(10, 'admin', { forzar: false });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST / — siempre borrador', () => {
  test('crea la receta sin activarla aunque el cliente pida activar', async () => {
    mockService.crearReceta.mockResolvedValue(recetaActiva({ id: 12, version: 1, activa: false }));

    const res = await invocar('post', '/', reqFalso({}, {
      producto_key: 'PT-NUEVO',
      nombre_producto: 'Producto nuevo',
      activar: true,
      insumos: [{ insumo_id: 1, cantidad_por_caja: 3 }]
    }));

    expect(res.statusCode).toBe(201);
    expect(mockService.activarReceta).not.toHaveBeenCalled();
    expect(mockService.crearReceta.mock.calls[0][0]).not.toHaveProperty('activar');
    expect(res.cuerpo.receta.activa).toBe(false);
  });

  test('rechaza un insumo que no existe en inventario', async () => {
    mockService.resolverNombresInventario.mockResolvedValue(new Map());

    const res = await invocar('post', '/', reqFalso({}, {
      producto_key: 'PT-X',
      insumos: [{ insumo_id: 999, cantidad_por_caja: 1 }]
    }));

    expect(res.statusCode).toBe(400);
    expect(mockService.crearReceta).not.toHaveBeenCalled();
  });
});

describe('GET /:id/impacto — simula la receta pedida', () => {
  test('pasa el id para que un borrador muestre SU impacto, no el de la vigente', async () => {
    const borrador = recetaActiva({ id: 11, version: 4, activa: false });
    mockService.obtenerRecetaPorId.mockResolvedValue(borrador);
    mockService.simularImpacto.mockResolvedValue({ version: 4, insumos: [], cobertura: [] });

    const res = await invocar('get', '/:id/impacto', reqFalso({ id: '11' }, {}, { cajas: '5' }));

    expect(res.statusCode).toBeNull();
    expect(mockService.simularImpacto).toHaveBeenCalledWith('PT-B1', 5, expect.anything(), 11);
  });

  test('rechaza cajas <= 0', async () => {
    mockService.obtenerRecetaPorId.mockResolvedValue(recetaActiva());
    const res = await invocar('get', '/:id/impacto', reqFalso({ id: '10' }, {}, { cajas: '0' }));
    expect(res.statusCode).toBe(400);
    expect(mockService.simularImpacto).not.toHaveBeenCalled();
  });
});
