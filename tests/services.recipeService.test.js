/**
 * Tests del motor de recetas.
 *
 * No se toca PostgreSQL: se inyecta un doble de `db` que responde por patrón de
 * SQL. Lo que se verifica aquí es la lógica que antes vivía hardcodeada y que
 * ningún test cubría: expansión de sub-recetas, suma de insumos compartidos,
 * merma, cobertura de stock, ciclos y diferencias entre versiones.
 */

jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));

const servicio = require('../services/recipeService');

/** Base de datos falsa: responde por patrón y registra lo que se le pidió. */
function crearPoolFake({ recetas = [], lineas = {}, inventario = [], compartidos = [] }) {
  const registro = { selects: [], inserts: [], updates: [] };

  async function query(sql, params = []) {
    registro.selects.push({ sql, params });

    if (/^\s*SELECT \* FROM recetas WHERE id/.test(sql)) {
      return { rows: recetas.filter(r => r.id === Number(params[0])), rowCount: 1 };
    }
    if (/FROM receta_insumos ri/.test(sql) && /receta_id = \$1/.test(sql)) {
      return { rows: lineas[params[0]] || [], rowCount: (lineas[params[0]] || []).length };
    }
    if (/WHERE producto_key = \$1 AND activa = true/.test(sql)) {
      const r = recetas.find(x => x.producto_key === params[0] && x.activa);
      return { rows: r ? [r] : [] };
    }
    if (/SELECT DISTINCT producto_key FROM recetas/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT id FROM inventario WHERE id = ANY/.test(sql)) {
      const ids = (params[0] || []).map(Number);
      return { rows: inventario.filter(i => ids.includes(i.id)).map(i => ({ id: i.id })) };
    }
    if (/SELECT id, nombre FROM inventario WHERE id = ANY/.test(sql)
      || /SELECT id, nombre, unidad_medida FROM inventario WHERE id = ANY/.test(sql)) {
      const ids = (params[0] || []).map(Number);
      return { rows: inventario.filter(i => ids.includes(i.id)) };
    }
    if (/SELECT id, nombre, unidad_medida, categoria FROM inventario WHERE id = ANY/.test(sql)) {
      const ids = (params[0] || []).map(Number);
      return { rows: inventario.filter(i => ids.includes(i.id)) };
    }
    if (/SELECT nombre FROM inventario/.test(sql)) {
      return { rows: inventario.map(i => ({ nombre: i.nombre })) };
    }
    if (/SELECT id FROM inventario$/.test(sql.trim())) {
      return { rows: inventario.map(i => ({ id: i.id })) };
    }
    if (/SELECT id FROM recetas WHERE id = ANY/.test(sql)) {
      const ids = (params[0] || []).map(Number);
      return { rows: recetas.filter(r => ids.includes(r.id)).map(r => ({ id: r.id })) };
    }
    if (/SELECT producto_key FROM recetas WHERE id = \$1/.test(sql)) {
      const r = recetas.find(x => x.id === Number(params[0]));
      return { rows: r ? [r] : [] };
    }
    if (/SELECT COALESCE\(MAX\(version\)/.test(sql)) {
      const versiones = recetas.filter(r => r.producto_key === params[0]).map(r => r.version);
      return { rows: [{ v: (versiones.length ? Math.max(...versiones) : 0) + 1 }] };
    }
    if (/componente_receta_id FROM receta_insumos/.test(sql)) {
      const id = Number(params[0]);
      return { rows: (lineas[id] || []).filter(l => l.componente_receta_id).map(l => ({ componente_receta_id: l.componente_receta_id })) };
    }
    if (/r2\.producto_key/.test(sql)) {
      return { rows: compartidos };
    }
    if (/^INSERT INTO receta_insumos/.test(sql)) {
      registro.inserts.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO recetas/.test(sql)) {
      const [producto_key, nombre_producto, origen, version] = params;
      const nueva = { id: 999, producto_key, nombre_producto, origen, version, activa: false };
      recetas.push(nueva);
      return { rows: [nueva], rowCount: 1 };
    }
    if (/^UPDATE recetas/.test(sql)) {
      registro.updates.push({ sql, params });
      return { rows: recetas.filter(r => r.id === Number(params[params.length - 1])), rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  const pool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
  return { pool, registro };
}

function insumo(over = {}) {
  return Object.assign({
    id: 1,
    receta_id: 1,
    insumo_id: 1,
    componente_receta_id: null,
    insumo_nombre: 'Resina PET',
    cantidad_por_caja: 2,
    cantidad_efectiva: 2,
    merma_pct: 0,
    stock_minimo: null,
    unidad_medida: 'KG',
    obligatorio: true,
    orden: 0,
    notas: '',
    nombre_inventario: 'Resina PET',
    unidad_inventario: 'KG',
    categoria_inventario: 'Materia prima',
    stock_actual: 100
  }, over);
}

describe('evaluarCobertura', () => {
  test('marca alcanza cuando el stock cubre lo solicitado', () => {
    const [c] = servicio.evaluarCobertura([
      { insumo_id: 1, nombre: 'Resina', unidad: 'KG', obligatorio: true, stock_actual: 50, cantidad: 20, stock_minimo: null }
    ], 10);
    expect(c.alcanza).toBe(true);
    expect(c.cajas_posibles).toBe(25); // 20 en 10 cajas = 2/caja; 50 / 2
  });

  test('marca falta cuando el stock no cubre lo solicitado', () => {
    const [c] = servicio.evaluarCobertura([
      { insumo_id: 1, nombre: 'Resina', unidad: 'KG', obligatorio: true, stock_actual: 25, cantidad: 40, stock_minimo: null }
    ], 10);
    expect(c.alcanza).toBe(false);
    expect(c.por_caja).toBe(4);
  });

  test('el sobrante se refleja en cuántas cajas del producto se pueden sacar', () => {
    const [c] = servicio.evaluarCobertura([
      { insumo_id: 1, nombre: 'Resina', unidad: 'KG', obligatorio: true, stock_actual: 100, cantidad: 30, stock_minimo: null }
    ], 10);
    expect(c.alcanza).toBe(true);
    expect(c.por_caja).toBe(3);
    expect(c.cajas_posibles).toBe(33); // 100 / 3
  });

  test('avisa cuando al descontar el stock queda por debajo del mínimo', () => {
    const [c] = servicio.evaluarCobertura([
      { insumo_id: 1, nombre: 'Resina', unidad: 'KG', obligatorio: true, stock_actual: 30, cantidad: 20, stock_minimo: 25 }
    ], 10);
    expect(c.alcanza).toBe(true);
    expect(c.queda_bajo_minimo).toBe(true);
  });

  test('ordena por insumo_id para que los bloqueos sean siempre en el mismo orden', () => {
    const r = servicio.evaluarCobertura([
      { insumo_id: 9, nombre: 'B', obligatorio: true, stock_actual: 10, cantidad: 1 },
      { insumo_id: 2, nombre: 'A', obligatorio: true, stock_actual: 10, cantidad: 1 },
      { insumo_id: 5, nombre: 'C', obligatorio: true, stock_actual: 10, cantidad: 1 }
    ], 1);
    expect(r.map(c => c.insumo_id)).toEqual([2, 5, 9]);
  });
});

describe('calcularInsumosProduccion', () => {
  test('devuelve [] si el producto no tiene receta vigente', async () => {
    const { pool } = crearPoolFake({ recetas: [], lineas: {} });
    await expect(servicio.calcularInsumosProduccion('nada', 5, pool)).resolves.toEqual([]);
  });

  test('multiplica la cantidad por caja por las cajas pedidas', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'b1_1lt', version: 1, activa: true }],
      lineas: { 1: [insumo({ cantidad_por_caja: 2, cantidad_efectiva: 2, stock_actual: 500 })] }
    });
    const r = await servicio.calcularInsumosProduccion('b1_1lt', 10, pool);
    expect(r).toHaveLength(1);
    expect(r[0].insumo_id).toBe(1);
    expect(r[0].cantidad_por_caja).toBe(2);
    expect(r[0].cantidad).toBe(20);
    expect(r[0].nombre_producto).toBe('b1_1lt');
  });

  test('usa el nombre canónico del inventario, no el que quedó en la receta', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'p', version: 1, activa: true }],
      lineas: {
        1: [insumo({
          insumo_nombre: 'TAPA DOSF. N° 26 BLANCO / DORADO',
          nombre_inventario: 'Tapa dosif. N° 26 blanco / Dorado'
        })]
      }
    });
    const r = await servicio.calcularInsumosProduccion('p', 1, pool);
    expect(r[0].nombre).toBe('Tapa dosif. N° 26 blanco / Dorado');
  });

  test('despliega la sub-receta y suma sus insumos', async () => {
    const { pool } = crearPoolFake({
      recetas: [
        { id: 1, producto_key: 'padre', version: 1, activa: true, nombre_producto: 'Padre' },
        { id: 2, producto_key: 'hijo', version: 1, activa: true, vigente_desde: '2020-01-01', vigente_hasta: null }
      ],
      lineas: {
        1: [insumo({ componente_receta_id: 2, insumo_id: null, insumo_nombre: 'Hijo', cantidad_por_caja: 3, cantidad_efectiva: 3 })],
        2: [insumo({ receta_id: 2, insumo_id: 7, insumo_nombre: 'Tapa', cantidad_por_caja: 4, cantidad_efectiva: 4, stock_actual: 90 })]
      }
    });
    const r = await servicio.calcularInsumosProduccion('padre', 2, pool);
    expect(r).toHaveLength(1);
    expect(r[0].insumo_id).toBe(7);
    expect(r[0].cantidad).toBe(24);      // 2 cajas * 3 sub-ensamblados * 4 tapas
    expect(r[0].cantidad_por_caja).toBe(12);
  });

  test('un insumo usado en dos sitios se cuenta una sola vez con la suma', async () => {
    const { pool } = crearPoolFake({
      recetas: [
        { id: 1, producto_key: 'padre', version: 1, activa: true },
        { id: 2, producto_key: 'hijo', version: 1, activa: true, vigente_desde: '2020-01-01', vigente_hasta: null }
      ],
      lineas: {
        1: [
          insumo({ componente_receta_id: 2, insumo_id: null, cantidad_por_caja: 2, cantidad_efectiva: 2 }),
          insumo({ insumo_id: 5, cantidad_por_caja: 1, cantidad_efectiva: 1, orden: 1 })
        ],
        2: [insumo({ receta_id: 2, insumo_id: 5, cantidad_por_caja: 3, cantidad_efectiva: 3, orden: 0 })]
      }
    });
    const r = await servicio.calcularInsumosProduccion('padre', 1, pool);
    expect(r).toHaveLength(1);
    expect(r[0].insumo_id).toBe(5);
    expect(r[0].cantidad).toBe(7); // 1 directa + 3 a través de 2 sub-ensamblados
    expect(r[0].lineas_por_caja || 1).toBeDefined();
  });

  test('rechaza un ciclo de recetas en lugar de reventar la pila', async () => {
    const { pool } = crearPoolFake({
      recetas: [
        { id: 1, producto_key: 'a', version: 1, activa: true, vigente_desde: '2020-01-01', vigente_hasta: null },
        { id: 2, producto_key: 'b', version: 1, activa: true, vigente_desde: '2020-01-01', vigente_hasta: null }
      ],
      lineas: {
        1: [insumo({ componente_receta_id: 2, insumo_id: null, cantidad_por_caja: 1 })],
        2: [insumo({ receta_id: 2, componente_receta_id: 1, insumo_id: null, cantidad_por_caja: 1 })]
      }
    });
    await expect(servicio.calcularInsumosProduccion('a', 1, pool))
      .rejects.toThrow(/Ciclo de recetas detectado/);
  });

  test('rechaza una sub-receta que no tiene versión vigente', async () => {
    const { pool } = crearPoolFake({
      recetas: [
        { id: 1, producto_key: 'padre', version: 1, activa: true },
        { id: 2, producto_key: 'hijo', version: 1, activa: false, vigente_desde: '2020-01-01', vigente_hasta: null }
      ],
      lineas: {
        1: [insumo({ componente_receta_id: 2, insumo_id: null, cantidad_por_caja: 1 })],
        2: [insumo({ receta_id: 2 })]
      }
    });
    await expect(servicio.calcularInsumosProduccion('padre', 1, pool))
      .rejects.toThrow(/no tiene una version vigente/);
  });

  test('rechaza una línea sin insumo ni componente', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'p', version: 1, activa: true }],
      lineas: { 1: [insumo({ insumo_id: null, componente_receta_id: null, nombre_inventario: null })] }
    });
    await expect(servicio.calcularInsumosProduccion('p', 1, pool))
      .rejects.toThrow(/sin insumo ni componente/);
  });

  test('cae a cantidad_por_caja cuando la columna generated no viene', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'p', version: 1, activa: true }],
      lineas: { 1: [insumo({ cantidad_por_caja: 1.5, cantidad_efectiva: undefined })] }
    });
    const r = await servicio.calcularInsumosProduccion('p', 4, pool);
    expect(r[0].cantidad).toBe(6);
  });
});

describe('simularImpacto', () => {
  test('devuelve null si no hay receta vigente', async () => {
    const { pool } = crearPoolFake({ recetas: [], lineas: {} });
    await expect(servicio.simularImpacto('nada', 3, pool)).resolves.toBeNull();
  });

  test('lista los faltantes y aun así dice cuántas caja sí da el stock', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'p', version: 3, activa: true, nombre_producto: 'Producto P' }],
      lineas: {
        1: [
          insumo({ insumo_id: 1, cantidad_por_caja: 2, cantidad_efectiva: 2, stock_actual: 5 }),
          insumo({ insumo_id: 2, insumo_nombre: 'Tapa', nombre_inventario: 'Tapa', cantidad_por_caja: 1, cantidad_efectiva: 1, stock_actual: 500, orden: 1 })
        ]
      }
    });
    const im = await servicio.simularImpacto('p', 10, pool);
    expect(im.version).toBe(3);
    expect(im.insumos).toHaveLength(2);
    expect(im.faltantes).toHaveLength(1);
    expect(im.faltantes[0]).toMatch(/Resina PET: requiere 20 \| stock: 5/);
    expect(im.cajas_maximas).toBe(2); // 5 de resina / 2 por caja
  });

  test('calcula cuántas cajas salen del stock real cuando no falta nada', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'p', version: 1, activa: true }],
      lineas: {
        1: [
          insumo({ insumo_id: 1, cantidad_por_caja: 2, cantidad_efectiva: 2, stock_actual: 40 }),
          insumo({ insumo_id: 2, insumo_nombre: 'Tapa', nombre_inventario: 'Tapa', cantidad_por_caja: 1, cantidad_efectiva: 1, stock_actual: 7, orden: 1 })
        ]
      }
    });
    const im = await servicio.simularImpacto('p', 1, pool);
    expect(im.faltantes).toHaveLength(0);
    expect(im.cajas_maximas).toBe(7); // lo limita la tapa
  });

  test('un insumo opcional que no alcanza sale como advertencia, no como faltante', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'p', version: 1, activa: true }],
      lineas: {
        1: [
          insumo({ insumo_id: 1, cantidad_por_caja: 1, cantidad_efectiva: 1, stock_actual: 10 }),
          insumo({ insumo_id: 2, insumo_nombre: 'Caja', nombre_inventario: 'Caja', cantidad_por_caja: 1, cantidad_efectiva: 1, stock_actual: 0, obligatorio: false, orden: 1 })
        ]
      }
    });
    const im = await servicio.simularImpacto('p', 5, pool);
    expect(im.faltantes).toHaveLength(0);
    expect(im.advertencias.join(' ')).toMatch(/Insumo opcional "Caja" no alcanza/);
    expect(im.cajas_maximas).toBe(10); // obligatorio: 1/caja con 10 en stock
  });

  test('lista los otros productos que comparten insumos', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1, producto_key: 'p', version: 1, activa: true }],
      lineas: { 1: [insumo({ insumo_id: 1, cantidad_por_caja: 1, cantidad_efectiva: 1 })] },
      compartidos: [{ producto_key: 'otro', nombre_producto: 'Otro producto', insumo_id: 1, insumo_nombre: 'Resina PET' }]
    });
    const im = await servicio.simularImpacto('p', 1, pool);
    expect(im.productos_que_comparten_insumos).toHaveLength(1);
    expect(im.productos_que_comparten_insumos[0].nombre).toBe('Otro producto');
    expect(im.productos_que_comparten_insumos[0].insumos[0].insumo).toBe('Resina PET');
  });

  test('incluye el árbol de sub-recetas para pintarlo en la UI', async () => {
    const { pool } = crearPoolFake({
      recetas: [
        { id: 1, producto_key: 'padre', version: 1, activa: true, nombre_producto: 'Padre' },
        { id: 2, producto_key: 'hijo', version: 1, activa: true, vigente_desde: '2020-01-01', vigente_hasta: null }
      ],
      lineas: {
        1: [insumo({ componente_receta_id: 2, insumo_id: null, cantidad_por_caja: 1, cantidad_efectiva: 1 })],
        2: [insumo({ receta_id: 2, insumo_id: 7, cantidad_por_caja: 2, cantidad_efectiva: 2 })]
      }
    });
    const im = await servicio.simularImpacto('padre', 1, pool);
    expect(im.arbol).toHaveLength(1);
    expect(im.arbol[0].tipo).toBe('subreceta');
    expect(im.arbol[0].sub_insumos[0].insumo_id).toBe(7);
  });
});

describe('validarLineas', () => {
  test('exige al menos una línea', async () => {
    const { pool } = crearPoolFake({});
    const r = await servicio.validarLineas([], pool);
    expect(r.ok).toBe(false);
    expect(r.errores[0]).toMatch(/al menos un insumo/);
  });

  test('rechaza cantidad por caja en cero o negativa', async () => {
    const { pool } = crearPoolFake({ inventario: [{ id: 1 }] });
    const r = await servicio.validarLineas([{ insumo_id: 1, cantidad_por_caja: 0, merma_pct: 0 }], pool);
    expect(r.ok).toBe(false);
    expect(r.errores[0]).toMatch(/mayor que 0/);
  });

  test('rechaza merma fuera de rango', async () => {
    const { pool } = crearPoolFake({ inventario: [{ id: 1 }] });
    const alta = await servicio.validarLineas([{ insumo_id: 1, cantidad_por_caja: 1, merma_pct: 100 }], pool);
    expect(alta.ok).toBe(false);
    expect(alta.errores[0]).toMatch(/entre 0 y 99.99/);
    const baja = await servicio.validarLineas([{ insumo_id: 1, cantidad_por_caja: 1, merma_pct: -1 }], pool);
    expect(baja.ok).toBe(false);
  });

  test('rechaza una línea que sea insumo y componente a la vez', async () => {
    const { pool } = crearPoolFake({ inventario: [{ id: 1 }], recetas: [{ id: 2 }] });
    const r = await servicio.validarLineas([{ insumo_id: 1, componente_receta_id: 2, cantidad_por_caja: 1, merma_pct: 0 }], pool);
    expect(r.ok).toBe(false);
    expect(r.errores[0]).toMatch(/excluyentes/);
  });

  test('detecta un insumo_id que no existe en inventario', async () => {
    const { pool } = crearPoolFake({ inventario: [{ id: 1 }] });
    const r = await servicio.validarLineas([{ insumo_id: 99, cantidad_por_caja: 1, merma_pct: 0 }], pool);
    expect(r.ok).toBe(false);
    expect(r.errores[0]).toMatch(/no existe en inventario/);
  });

  test('detecta un componente que no existe', async () => {
    const { pool } = crearPoolFake({ inventario: [], recetas: [] });
    const r = await servicio.validarLineas([{ componente_receta_id: 42, cantidad_por_caja: 1, merma_pct: 0 }], pool);
    expect(r.ok).toBe(false);
    expect(r.errores[0]).toMatch(/componentes que no existen/);
  });

  test('acepta una lista válida con merma y stock de seguridad', async () => {
    const { pool } = crearPoolFake({ inventario: [{ id: 1 }, { id: 2 }], recetas: [{ id: 3 }] });
    const r = await servicio.validarLineas([
      { insumo_id: 1, cantidad_por_caja: 2, merma_pct: 3.5, stock_minimo: 10 },
      { componente_receta_id: 3, cantidad_por_caja: 1, merma_pct: 0 }
    ], pool);
    expect(r.ok).toBe(true);
    expect(r.errores).toEqual([]);
  });
});

describe('detectaCiclo', () => {
  test('detecta la autorreferencia directa', async () => {
    const { pool } = crearPoolFake({});
    await expect(servicio.detectaCiclo(7, [7], pool)).resolves.toBe(true);
  });

  test('detecta el ciclo indirecto A -> B -> C -> A', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1 }, { id: 2 }, { id: 3 }],
      lineas: {
        2: [insumo({ componente_receta_id: 3 })],
        3: [insumo({ receta_id: 3, componente_receta_id: 1 })]
      }
    });
    await expect(servicio.detectaCiclo(1, [2], pool)).resolves.toBe(true);
  });

  test('deja pasar una jerarquía sin ciclos', async () => {
    const { pool } = crearPoolFake({
      recetas: [{ id: 1 }, { id: 2 }, { id: 3 }],
      lineas: { 2: [insumo({ componente_receta_id: 3 })] }
    });
    await expect(servicio.detectaCiclo(1, [2], pool)).resolves.toBe(false);
  });

  test('sin componentes no hay ciclo', async () => {
    const { pool } = crearPoolFake({});
    await expect(servicio.detectaCiclo(1, [], pool)).resolves.toBe(false);
  });
});

describe('insertarLineas', () => {
  test('copia el nombre y la unidad del inventario, no los del cliente', async () => {
    const { pool, registro } = crearPoolFake({
      recetas: [{ id: 2, producto_key: 'sub' }],
      inventario: [{ id: 1, nombre: 'Resina PET', unidad_medida: 'KG' }]
    });
    await servicio.insertarLineas(pool, 50, [
      { insumo_id: 1, nombre: 'lo que sea', unidad: 'LT', cantidad_por_caja: 2, merma_pct: 0 }
    ], 'p');

    expect(registro.inserts).toHaveLength(1);
    const params = registro.inserts[0].params;
    expect(params[1]).toBe('Resina PET');       // insumo_nombre
    expect(params[5]).toBe('KG');              // unidad_medida
    expect(params[9]).toBe(1);                 // insumo_id
  });

  test('guarda merma y stock de seguridad tal cual', async () => {
    const { pool, registro } = crearPoolFake({
      inventario: [{ id: 1, nombre: 'Resina', unidad_medida: 'KG' }]
    });
    await servicio.insertarLineas(pool, 50, [
      { insumo_id: 1, cantidad_por_caja: 2, merma_pct: 4.25, stock_minimo: 15 }
    ], 'p');
    const params = registro.inserts[0].params;
    expect(params[3]).toBe(4.25);
    expect(params[4]).toBe(15);
  });

  test('acepta stock de seguridad vacío como null', async () => {
    const { pool, registro } = crearPoolFake({
      inventario: [{ id: 1, nombre: 'Resina', unidad_medida: 'KG' }]
    });
    await servicio.insertarLineas(pool, 50, [
      { insumo_id: 1, cantidad_por_caja: 2, merma_pct: 0, stock_minimo: '' }
    ], 'p');
    expect(registro.inserts[0].params[4]).toBeNull();
  });

  test('falla si el insumo no está en inventario en vez de escribir basura', async () => {
    const { pool } = crearPoolFake({ inventario: [] });
    await expect(servicio.insertarLineas(pool, 50, [
      { insumo_id: 77, cantidad_por_caja: 1, merma_pct: 0 }
    ], 'p')).rejects.toThrow(/no existe en inventario/);
  });
});

describe('diffReceta', () => {
  test('marca agregados, quitados y modificados frente a la vigente', async () => {
    const { pool } = crearPoolFake({
      recetas: [
        { id: 1, producto_key: 'p', version: 1, activa: true },
        { id: 2, producto_key: 'p', version: 2, activa: false }
      ],
      lineas: {
        1: [
          insumo({ receta_id: 1, insumo_id: 1, cantidad_por_caja: 2, cantidad_efectiva: 2 }),
          insumo({ receta_id: 1, insumo_id: 2, insumo_nombre: 'Tapa', nombre_inventario: 'Tapa', cantidad_por_caja: 1, cantidad_efectiva: 1, orden: 1 })
        ],
        2: [
          insumo({ receta_id: 2, insumo_id: 1, cantidad_por_caja: 3, cantidad_efectiva: 3, merma_pct: 2 }),
          insumo({ receta_id: 2, insumo_id: 3, insumo_nombre: 'Etiqueta', nombre_inventario: 'Etiqueta', cantidad_por_caja: 1, cantidad_efectiva: 1, orden: 1 })
        ]
      }
    });
    const d = await servicio.diffReceta(2, pool);
    expect(d.hay_cambios).toBe(true);
    expect(d.vigente).toEqual({ id: 1, version: 1 });
    expect(d.cambios.quitados.map(l => l.insumo_id)).toEqual([2]);
    expect(d.cambios.agregados.map(l => l.insumo_id)).toEqual([3]);
    const campos = d.cambios.modificados[0].campos.map(c => c.campo);
    expect(campos).toEqual(expect.arrayContaining(['cantidad_por_caja', 'merma_pct']));
  });

  test('sin cambios devuelve hay_cambios false', async () => {
    const linea = insumo({ receta_id: 1, cantidad_por_caja: 2 });
    const { pool } = crearPoolFake({
      recetas: [
        { id: 1, producto_key: 'p', version: 1, activa: true },
        { id: 2, producto_key: 'p', version: 2, activa: false }
      ],
      lineas: { 1: [linea], 2: [Object.assign({}, linea, { receta_id: 2 })] }
    });
    const d = await servicio.diffReceta(2, pool);
    expect(d.hay_cambios).toBe(false);
  });
});

describe('activarReceta', () => {
  const db = require('../db');

  function montar({ recetas = [], lineas = {}, inventario = [] } = {}) {
    const { pool, registro } = crearPoolFake({ recetas, lineas, inventario });
    db.query.mockImplementation(pool.query);
    db.connect.mockImplementation(async () => ({ query: pool.query, release: jest.fn() }));
    return registro;
  }

  const tocoRecetas = registro => registro.updates.some(u => /^UPDATE recetas/.test(u.sql));

  afterEach(() => {
    db.query.mockReset();
    db.connect.mockReset();
  });

  test('sin stock devuelve requiere_confirmacion y NO toca recetas', async () => {
    const registro = montar({
      recetas: [{ id: 1, producto_key: 'p', nombre_producto: 'P', version: 1, activa: false }],
      lineas: { 1: [insumo({ stock_actual: 0, cantidad_por_caja: 10 })] },
      inventario: [{ id: 1, nombre: 'Resina PET', unidad_medida: 'KG', stock: 0 }]
    });

    const r = await servicio.activarReceta(1, 'admin', { cajas: 1 });

    expect(r.success).toBe(false);
    expect(r.requiere_confirmacion).toBe(true);
    expect(r.faltantes.length).toBeGreaterThan(0);
    expect(tocoRecetas(registro)).toBe(false);
  });

  test('forzar salta el aviso de stock y activa', async () => {
    const registro = montar({
      recetas: [{ id: 1, producto_key: 'p', nombre_producto: 'P', version: 1, activa: false }],
      lineas: { 1: [insumo({ stock_actual: 0, cantidad_por_caja: 10 })] },
      inventario: [{ id: 1, nombre: 'Resina PET', unidad_medida: 'KG', stock: 0 }]
    });

    const r = await servicio.activarReceta(1, 'admin', { cajas: 1, forzar: true });

    expect(r.success).toBe(true);
    expect(r.requiere_confirmacion).toBe(false);
    expect(tocoRecetas(registro)).toBe(true);
  });

  test('forzar NO habilita un BOM cíclico: forzar es solo por stock', async () => {
    const registro = montar({
      recetas: [
        { id: 1, producto_key: 'a', nombre_producto: 'A', version: 1, activa: true },
        { id: 2, producto_key: 'b', nombre_producto: 'B', version: 1, activa: true }
      ],
      lineas: {
        1: [insumo({ componente_receta_id: 2, insumo_id: null, cantidad_por_caja: 1 })],
        2: [insumo({ receta_id: 2, componente_receta_id: 1, insumo_id: null, cantidad_por_caja: 1 })]
      }
    });

    await expect(servicio.activarReceta(1, 'admin', { cajas: 1, forzar: true }))
      .rejects.toThrow(/Ciclo de recetas detectado/);
    expect(tocoRecetas(registro)).toBe(false);
  });
});

describe('idsInsumosFaltantes', () => {
  test('devuelve solo los ids que no están en inventario', async () => {
    const { pool } = crearPoolFake({ inventario: [{ id: 1 }, { id: 3 }] });
    const r = await servicio.idsInsumosFaltantes([{ insumo_id: 1 }, { insumo_id: 2 }, { insumo_id: 3 }], pool);
    expect(r).toEqual([2]);
  });

  test('sin datos no hace nada', async () => {
    const { pool } = crearPoolFake({});
    await expect(servicio.idsInsumosFaltantes([], pool)).resolves.toEqual([]);
  });
});

describe('contrato del módulo', () => {
  test('exporta todo lo que usan las rutas', () => {
    [
      'obtenerRecetaPorId', 'obtenerRecetaVigente', 'listarRecetas', 'crearReceta',
      'activarReceta', 'clonarRecetaParaEdicion', 'calcularInsumosProduccion',
      'simularImpacto', 'evaluarCobertura', 'validarLineas', 'detectaCiclo',
      'idsInsumosFaltantes', 'insertarLineas', 'diffReceta'
    ].forEach(fn => expect(typeof servicio[fn]).toBe('function'));
  });

  test('el límite de anidamiento es finito', () => {
    expect(servicio.PROFUNDIDAD_MAXIMA).toBeGreaterThan(0);
    expect(servicio.PROFUNDIDAD_MAXIMA).toBeLessThan(20);
  });
});
