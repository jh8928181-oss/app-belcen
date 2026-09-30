const pool = require('../db');
const { normalizar } = require('../utils/helpers');

const PROFUNDIDAD_MAXIMA = 5;

/**
 * Devuelve los ids de inventario que NO aparecen en la lista de insumos.
 * Acepta objetos con insumo_id o con nombre (por compatibilidad).
 */
async function idsInsumosFaltantes(insumos, db = pool) {
  const ids = (insumos || []).map(i => (i && i.insumo_id) || null).filter(Boolean);
  const nombres = (insumos || []).map(i => (i && i.nombre) || '').filter(Boolean);
  if (!ids.length && !nombres.length) return [];

  if (ids.length) {
    const r = await db.query('SELECT id FROM inventario WHERE id = ANY($1::int[])', [ids]);
    const existentes = new Set(r.rows.map(x => x.id));
    return ids.filter(id => !existentes.has(id));
  }

  const r = await db.query('SELECT nombre FROM inventario');
  const catalogo = new Set(r.rows.map(x => normalizar(x.nombre)));
  return nombres.filter(n => !catalogo.has(normalizar(n)));
}

/** Conservado por compatibilidad con las rutas que pasan nombres. */
async function insumosFaltantesEnInventario(insumos, db = pool) {
  const ids = (insumos || []).map(i => (i && i.insumo_id) || null).filter(Boolean);
  if (ids.length) return ids.map(String);

  const faltantes = await idsInsumosFaltantes(insumos, db);
  const r = await db.query('SELECT id FROM inventario');
  const validos = new Set(r.rows.map(x => String(x.id)));
  return faltantes.filter(f => !validos.has(String(f)));
}

/** Resuelve el nombre canonico que el inventario tiene para cada id. */
async function resolverNombresInventario(ids, db = pool) {
  if (!ids.length) return new Map();
  const r = await db.query(
    'SELECT id, nombre, unidad_medida, categoria FROM inventario WHERE id = ANY($1::int[])',
    [ids]
  );
  return new Map(r.rows.map(x => [x.id, x]));
}

async function obtenerRecetaPorId(id, db = pool) {
  const receta = await db.query('SELECT * FROM recetas WHERE id = $1', [id]);
  if (!receta.rows.length) return null;
  const insumos = await db.query(
    `SELECT ri.*, inv.nombre AS nombre_inventario, inv.unidad_medida AS unidad_inventario,
            inv.categoria AS categoria_inventario, inv.stock AS stock_actual,
            sub.producto_key AS sub_producto_key, sub.nombre_producto AS sub_nombre_producto
       FROM receta_insumos ri
       LEFT JOIN inventario inv ON inv.id = ri.insumo_id
       LEFT JOIN recetas sub ON sub.id = ri.componente_receta_id
      WHERE ri.receta_id = $1 ORDER BY ri.orden, ri.id`,
    [id]
  );
  return { ...receta.rows[0], insumos: insumos.rows };
}

/** Todas las recetas del producto, de la mas nueva a la mas vieja. */
async function listarRecetas(db = pool) {
  const r = await db.query(`
    SELECT rr.*,
           pt.nombre_producto AS nombre_catalogo,
           (SELECT COUNT(*) FROM receta_insumos ri WHERE ri.receta_id = rr.id) AS num_insumos,
           (SELECT COUNT(*) FROM receta_insumos ri WHERE ri.receta_id = rr.id AND ri.componente_receta_id IS NOT NULL) AS num_subrecetas
      FROM recetas rr
      LEFT JOIN producto_terminado pt ON pt.producto_key = rr.producto_key
     ORDER BY rr.producto_key, rr.version DESC
  `);
  return r.rows;
}

/** Nombre legible de un producto, con la receta como respaldo. */
function nombreDe(recetaRow) {
  return recetaRow.nombre_producto || recetaRow.nombre_catalogo || recetaRow.producto_key;
}

async function obtenerRecetaVigente(producto_key, db = pool) {
  const receta = await db.query(`
    SELECT * FROM recetas
    WHERE producto_key = $1 AND activa = true
      AND vigente_desde <= CURRENT_DATE
      AND (vigente_hasta IS NULL OR vigente_hasta >= CURRENT_DATE)
    ORDER BY version DESC LIMIT 1
  `, [producto_key]);
  if (!receta.rows.length) return null;
  return await obtenerRecetaPorId(receta.rows[0].id, db);
}

/**
 * Motor de expansión. Recorre el BOM y devuelve HOJAS de inventario ya
 * Devuelve las hojas de inventario ya aplanadas, con la cantidad ABSOLUTA que
 * hay que descontar (multiplicadores ya aplicados) y el camino de sub-ensamblados
 * por el que se llegó a cada una.
 *
 * Las hojas se suman entre sí: si dos sub-ensamblados comparten una materia
 * prima, esa materia prima se descuenta una sola vez por la suma, no dos.
 */
async function resolverHojas(receta, multiplicador, db, contexto = {}) {
  const visitadas = contexto.visitadas || new Set();
  const profundidad = contexto.profundidad || 0;

  if (visitadas.has(receta.id)) {
    const nombres = [...visitadas].join(' -> ');
    throw new Error(
      `Ciclo de recetas detectado: ${nombres} -> ${receta.producto_key}. ` +
      'Una receta no puede contenerse a si misma.'
    );
  }
  if (profundidad > PROFUNDIDAD_MAXIMA) {
    throw new Error(
      `Anidamiento demasiado profundo (> ${PROFUNDIDAD_MAXIMA} niveles) al expandir ${receta.producto_key}. ` +
      'Revisa si hay una referencia circular entre recetas.'
    );
  }

  visitadas.add(receta.id);
  const factor = Number(multiplicador) || 0;
  const hojas = new Map();
  const arbol = [];
  const hoy = new Date().toISOString().slice(0, 10);

  for (const linea of receta.insumos) {
    // cantidad_efectiva ya trae la merma aplicada (columna generated).
    const porCaja = Number(linea.cantidad_efectiva ?? linea.cantidad_por_caja) || 0;
    const total = factor * porCaja;

    if (linea.componente_receta_id) {
      const sub = await obtenerRecetaPorId(linea.componente_receta_id, db);
      if (!sub) {
        throw new Error(`La receta ${receta.producto_key} referencia un componente que ya no existe.`);
      }
      if (!sub.activa || (sub.vigente_desde && sub.vigente_desde > hoy) ||
          (sub.vigente_hasta && sub.vigente_hasta < hoy)) {
        throw new Error(
          `El componente "${nombreDe(sub)}" de la receta ${receta.producto_key} no tiene una version vigente. ` +
          'Activala antes de usar la receta que lo contiene.'
        );
      }

      // El factor se propaga hacia abajo: las hojas que devuelva la sub-receta
      // ya vienen escaladas por la cantidad de sub-ensamblados que hacen falta.
      const subHojas = await resolverHojas(sub, total, db, {
        visitadas: new Set(visitadas),
        profundidad: profundidad + 1
      });

      for (const [id, dato] of subHojas) {
        const previo = hojas.get(id);
        hojas.set(id, previo
          ? { ...dato, cantidad_total: previo.cantidad_total + dato.cantidad_total }
          : dato);
      }

      arbol.push({
        tipo: 'subreceta',
        receta_id: sub.id,
        producto_key: sub.producto_key,
        nombre: nombreDe(sub),
        cantidad_por_caja: porCaja,
        cantidad_total: total,
        unidad: linea.unidad_medida,
        notas: linea.notas,
        sub_insumos: await árbolDe(sub, db, new Set(visitadas), profundidad + 1)
      });
      continue;
    }

    if (!linea.insumo_id) {
      throw new Error(
        `La receta ${receta.producto_key} tiene una linea sin insumo ni componente definido.`
      );
    }

    const previo = hojas.get(linea.insumo_id);
    const nombre = linea.nombre_inventario || linea.insumo_nombre;
    if (previo) {
      previo.cantidad_total += total;
      previo.lineas.push({ ...linea, cantidad_total: total });
    } else {
      hojas.set(linea.insumo_id, {
        insumo_id: linea.insumo_id,
        nombre,
        unidad: linea.unidad_inventario || linea.unidad_medida || 'UNIDADES',
        categoria: linea.categoria_inventario || '',
        stock_actual: Number(linea.stock_actual) || 0,
        obligatorio: linea.obligatorio !== false,
        stock_minimo: linea.stock_minimo === null || linea.stock_minimo === undefined || linea.stock_minimo === ''
          ? null
          : Number(linea.stock_minimo),
        cantidad_total: total,
        lineas: [{ ...linea, cantidad_total: total }]
      });
    }
    arbol.push({
      tipo: 'insumo',
      insumo_id: linea.insumo_id,
      nombre,
      cantidad_por_caja: porCaja,
      cantidad_total: total,
      unidad: linea.unidad_inventario || linea.unidad_medida,
      merma_pct: Number(linea.merma_pct) || 0,
      obligatorio: linea.obligatorio !== false,
      notas: linea.notas
    });
  }

  visitadas.delete(receta.id);
  return hojas;
}

/** Arbol de expansion sin cantidades absolutas, para pintar la UI. */
async function árbolDe(receta, db, visitadas, profundidad) {
  visitadas = visitadas || new Set();
  if (visitadas.has(receta.id) || (profundidad || 0) > PROFUNDIDAD_MAXIMA) return [];
  visitadas.add(receta.id);

  const salida = [];
  for (const linea of receta.insumos) {
    const porCaja = Number(linea.cantidad_efectiva ?? linea.cantidad_por_caja) || 0;
    if (linea.componente_receta_id) {
      const sub = await obtenerRecetaPorId(linea.componente_receta_id, db);
      if (!sub) continue;
      salida.push({
        tipo: 'subreceta',
        receta_id: sub.id,
        producto_key: sub.producto_key,
        nombre: nombreDe(sub),
        cantidad_por_caja: porCaja,
        unidad: linea.unidad_medida,
        sub_insumos: await árbolDe(sub, db, new Set(visitadas), (profundidad || 0) + 1)
      });
    } else {
      salida.push({
        tipo: 'insumo',
        insumo_id: linea.insumo_id,
        nombre: linea.nombre_inventario || linea.insumo_nombre,
        cantidad_por_caja: porCaja,
        unidad: linea.unidad_inventario || linea.unidad_medida,
        merma_pct: Number(linea.merma_pct) || 0,
        obligatorio: linea.obligatorio !== false,
        notas: linea.notas
      });
    }
  }
  visitadas.delete(receta.id);
  return salida;
}

/**
 * Insumos a descontar para producir `cajas` cajas de UNA receta concreta.
 * Devuelve una fila por hoja de inventario, con la cantidad total y el nombre
 * canonico (el del inventario, nunca el que envio el cliente).
 */
async function calcularInsumosDeReceta(receta, cajas, db = pool) {
  const multiplicador = Number(cajas) || 0;
  const hojas = await resolverHojas(receta, multiplicador, db);

  // resolverHojas ya devuelve la cantidad absoluta (con sub-recetas y merma
  // aplicadas). El "por caja" se deriva de ahí para poder mostrarlo en la UI.
  return Array.from(hojas.values()).map(h => ({
    insumo_id: h.insumo_id,
    nombre: h.nombre,
    cantidad: h.cantidad_total,
    cantidad_por_caja: multiplicador > 0 ? h.cantidad_total / multiplicador : 0,
    unidad: h.unidad,
    categoria: h.categoria,
    stock_actual: h.stock_actual,
    obligatorio: h.obligatorio,
    stock_minimo: h.stock_minimo,
    receta_id: receta.id,
    nombre_producto: nombreDe(receta)
  })).sort((a, b) => b.cantidad - a.cantidad);
}

/** Insumos a descontar para producir `cajas` cajas de la versión vigente. */
async function calcularInsumosProduccion(producto_key, cajas, db = pool) {
  const receta = await obtenerRecetaVigente(producto_key, db);
  if (!receta) return [];
  return calcularInsumosDeReceta(receta, cajas, db);
}

/**
 * Con el stock actual, cuántas cajas se pueden producir y qué falta.
 *
 * `cajas` es el tamaño del lote que se quiere sacar: con eso se convierte el
 * total solicitado en consumo por caja, y `cajas_posibles` es el número de
 * cajas del PRODUCTO que el stock actual alcanza (no del lote).
 *
 * Se ordena por insumo_id para que quien bloquee con FOR UPDATE tome los
 * bloqueos en el mismo orden y dos producciones concurrentes no se traben.
 */
function evaluarCobertura(insumos, cajas) {
  const lote = Number(cajas) || 0;
  return insumos
    .map(i => {
      const disponible = Number(i.stock_actual) || 0;
      const solicitado = Number(i.cantidad) || 0;
      const porCaja = lote > 0 && solicitado > 0 ? solicitado / lote : solicitado;
      const cajasPosibles = porCaja > 0 ? Math.floor(disponible / porCaja) : Infinity;
      return {
        insumo_id: i.insumo_id,
        nombre: i.nombre,
        unidad: i.unidad,
        obligatorio: i.obligatorio,
        disponible,
        solicitado,
        por_caja: porCaja,
        stock_minimo: i.stock_minimo,
        cajas_posibles: cajasPosibles,
        alcanza: disponible >= solicitado,
        queda_bajo_minimo: i.stock_minimo !== null &&
          (disponible - solicitado) < Number(i.stock_minimo)
      };
    })
    .sort((a, b) => a.insumo_id - b.insumo_id);
}

/**
 * Simula el impacto de una receta sin tocar nada.
 * `recetaId` permite simular un borrador concreto; sin él usa la vigente.
 */
async function simularImpacto(producto_key, cajas, db = pool, recetaId = null) {
  const receta = recetaId
    ? await obtenerRecetaPorId(recetaId, db)
    : await obtenerRecetaVigente(producto_key, db);
  if (!receta) return null;

  const insumos = await calcularInsumosDeReceta(receta, cajas, db);
  const cobertura = evaluarCobertura(insumos, cajas);
  const obligatorios = cobertura.filter(c => c.obligatorio);
  const faltantes = obligatorios.filter(c => !c.alcanza);

  // Productos que comparten al menos una de estas hojas: tocar el stock de un
  // insumo compartido afecta tambien a sus recetas.
  const ids = insumos.map(i => i.insumo_id).filter(Boolean);
  let compartidos = [];
  if (ids.length) {
    const r = await db.query(`
      SELECT DISTINCT r2.producto_key, r2.nombre_producto, ri.insumo_id, ri.insumo_nombre
        FROM receta_insumos ri
        JOIN recetas r2 ON r2.id = ri.receta_id
       WHERE r2.activa = true AND ri.insumo_id = ANY($1::int[]) AND r2.producto_key <> $2
       ORDER BY r2.producto_key, ri.insumo_id
    `, [ids, producto_key]);
    const porProducto = new Map();
    r.rows.forEach(x => {
      const lista = porProducto.get(x.producto_key) || [];
      lista.push({ insumo_id: x.insumo_id, insumo: x.insumo_nombre });
      porProducto.set(x.producto_key, { producto_key: x.producto_key, nombre: x.nombre_producto || x.producto_key, insumos: lista });
    });
    compartidos = Array.from(porProducto.values());
  }

  return {
    producto_key,
    nombre: nombreDe(receta),
    receta_id: receta.id,
    version: receta.version,
    cajas,
    insumos,
    cobertura,
    arbol: await árbolDe(receta, db),
    faltantes: faltantes.map(f => `${f.nombre}: requiere ${f.solicitado} | stock: ${f.disponible}`),
    // Cuántas cajas del producto daría el stock actual. No es 0 solo porque el
    // lote pedido no quepa: eso ya lo dice `faltantes`.
    cajas_maximas: obligatorios.length
      ? Math.min(...obligatorios.map(c => c.cajas_posibles))
      : Infinity,
    productos_que_comparten_insumos: compartidos,
    advertencias: cobertura
      .filter(c => !c.obligatorio && !c.alcanza)
      .map(c => `Insumo opcional "${c.nombre}" no alcanza (stock ${c.disponible}, se piden ${c.solicitado}).`),
    despues: cobertura
      .filter(c => c.queda_bajo_minimo)
      .map(c => `"${c.nombre}" quedaria en ${c.disponible - c.solicitado}, por debajo de su minimo ${c.stock_minimo}.`)
  };
}

/** Valida una lista de lineas antes de escribirla. */
async function validarLineas(insumos, db = pool) {
  const errores = [];
  if (!Array.isArray(insumos) || !insumos.length) {
    return { ok: false, errores: ['La receta debe tener al menos un insumo.'] };
  }
  insumos.forEach((l, i) => {
    const n = i + 1;
    if (!l || (!l.insumo_id && !l.componente_receta_id)) {
      errores.push(`Linea ${n}: elige un insumo o un componente.`);
      return;
    }
    if (l.insumo_id && l.componente_receta_id) {
      errores.push(`Linea ${n}: un insumo y un componente son excluyentes.`);
    }
    if (!(Number(l.cantidad_por_caja) > 0)) {
      errores.push(`Linea ${n}: la cantidad por caja debe ser mayor que 0.`);
    }
    const merma = Number(l.merma_pct || 0);
    if (!(merma >= 0 && merma < 100)) {
      errores.push(`Linea ${n}: la merma debe estar entre 0 y 99.99 %.`);
    }
  });
  if (errores.length) return { ok: false, errores };

  const soloIds = insumos.filter(l => l.insumo_id && !l.componente_receta_id);
  const faltantes = await idsInsumosFaltantes(soloIds, db);
  if (faltantes.length) {
    return { ok: false, errores: [faltantes.length === 1
      ? `El insumo (id ${faltantes[0]}) no existe en inventario.`
      : `Hay ${faltantes.length} insumos que no existen en inventario.`] };
  }

  const soloSub = insumos.filter(l => l.componente_receta_id && !l.insumo_id);
  if (soloSub.length) {
    const r = await db.query('SELECT id FROM recetas WHERE id = ANY($1::int[])', [soloSub.map(l => l.componente_receta_id)]);
    const existen = new Set(r.rows.map(x => x.id));
    const malos = soloSub.map(l => l.componente_receta_id).filter(id => !existen.has(id));
    if (malos.length) return { ok: false, errores: [`Hay ${malos.length} componentes que no existen.`] };
  }

  return { ok: true, errores: [] };
}

/** ¿Alguno de estos componentes es esta misma receta (directa o indirectamente)? */
async function detectaCiclo(recetaId, componentes, db = pool) {
  const pendientes = componentes.filter(Boolean).map(Number);
  if (!pendientes.length) return false;
  if (pendientes.includes(Number(recetaId))) return true;

  const vistos = new Set([Number(recetaId)]);
  while (pendientes.length) {
    const id = pendientes.shift();
    if (vistos.has(id)) return true;
    vistos.add(id);
    const r = await db.query(
      'SELECT componente_receta_id FROM receta_insumos WHERE receta_id = $1 AND componente_receta_id IS NOT NULL',
      [id]
    );
    r.rows.forEach(x => pendientes.push(Number(x.componente_receta_id)));
  }
  return false;
}

/** Version siguiente del producto. */
async function siguienteVersion(producto_key, db = pool) {
  const r = await db.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM recetas WHERE producto_key = $1',
    [producto_key]
  );
  return r.rows[0].v;
}

/**
 * Inserta las lineas de una receta.
 * Nombre y unidad se copian SIEMPRE desde inventario: el cliente no decide como
 * se llama el insumo ni en que se mide. Asi el descuento posterior no puede fallar
 * por acentos, grados o puntuacion distinta, ni comparar kg contra litros.
 */
async function insertarLineas(client, recetaId, insumos, productoKey) {
  const ids = insumos.filter(l => l.insumo_id).map(l => l.insumo_id);
  let porId = new Map();
  if (ids.length) {
    const r = await client.query(
      'SELECT id, nombre, unidad_medida FROM inventario WHERE id = ANY($1::int[])',
      [ids]
    );
    porId = new Map(r.rows.map(x => [x.id, x]));
  }

  // "" llega desde el formulario cuando el campo quedó vacío: es "sin mínimo",
  // no cero.
  const minimo = v =>
    v === null || v === undefined || v === '' ? null : Number(v);

  for (const [orden, linea] of insumos.entries()) {
    if (linea.componente_receta_id) {
      const sub = await client.query(
        'SELECT producto_key FROM recetas WHERE id = $1',
        [linea.componente_receta_id]
      );
      await client.query(
        `INSERT INTO receta_insumos
           (receta_id, insumo_nombre, cantidad_por_caja, merma_pct, stock_minimo, unidad_medida, obligatorio, orden, notas, componente_receta_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          recetaId,
          String(linea.nombre || `Componente ${sub.rows[0] ? sub.rows[0].producto_key : linea.componente_receta_id}`).slice(0, 150),
          Number(linea.cantidad_por_caja),
          Number(linea.merma_pct || 0),
          minimo(linea.stock_minimo),
          String(linea.unidad || 'UNIDADES').slice(0, 20),
          linea.obligatorio !== false,
          orden,
          linea.notas || '',
          Number(linea.componente_receta_id)
        ]
      );
      continue;
    }

    const inv = porId.get(Number(linea.insumo_id));
    if (!inv) throw new Error(`El insumo (id ${linea.insumo_id}) no existe en inventario.`);

    await client.query(
      `INSERT INTO receta_insumos
         (receta_id, insumo_nombre, cantidad_por_caja, merma_pct, stock_minimo, unidad_medida, obligatorio, orden, notas, insumo_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        recetaId,
        inv.nombre,
        Number(linea.cantidad_por_caja),
        Number(linea.merma_pct || 0),
        minimo(linea.stock_minimo),
        String(inv.unidad_medida || linea.unidad || 'UNIDADES').slice(0, 20),
        linea.obligatorio !== false,
        orden,
        linea.notas || '',
        inv.id
      ]
    );
  }
  return productoKey;
}

/**
 * Crea una versión de receta. Siempre nace como borrador: activarla es una
 * decisión aparte (ver activarReceta), que es la que valida el stock.
 *
 * Si se pasa `client`, se usa esa conexión ya abierta y NO se abre ni se cierra
 * transacción: así quien edita una receta activa puede clonar el borrador dentro
 * de su propia transacción.
 */
async function crearReceta({ producto_key, nombre_producto, insumos, observaciones, created_by }, client = null) {
  const propia = !client;
  const conn = client || await pool.connect();
  const transaccion = async sql => {
    if (propia) await conn.query(sql);
  };
  try {
    await transaccion('BEGIN');
    await conn.query("SELECT set_config('app.current_user', $1, true)", [created_by || 'system']);

    const valida = await validarLineas(insumos, conn);
    if (!valida.ok) {
      await transaccion('ROLLBACK');
      const e = new Error(valida.errores[0]);
      e.detalles = valida.errores;
      throw e;
    }

    // Producto terminado del catálogo, si existe, para no duplicar el nombre.
    const pt = await conn.query(
      'SELECT nombre_producto FROM producto_terminado WHERE producto_key = $1',
      [producto_key]
    );
    const nombre = String(nombre_producto || (pt.rows[0] && pt.rows[0].nombre_producto) || producto_key).slice(0, 150);

    const version = await siguienteVersion(producto_key, conn);
    const r = await conn.query(
      `INSERT INTO recetas (producto_key, nombre_producto, origen, version, vigente_desde, activa, created_by, observaciones)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,false,$5,$6) RETURNING *`,
      [producto_key, nombre, pt.rows.length ? 'producto_terminado' : 'modulo_recetas', version, created_by, observaciones || '']
    );
    const recetaId = r.rows[0].id;

    await insertarLineas(conn, recetaId, insumos, producto_key);

    await transaccion('COMMIT');
    return await obtenerRecetaPorId(recetaId, conn);
  } catch (err) {
    await transaccion('ROLLBACK');
    if (err && err.code === '23505' && /uq_receta_vigente/.test(err.constraint || '')) {
      const e = new Error('Ya hay una receta vigente de este producto. Activala o desactiva la otra.');
      e.status = 409;
      throw e;
    }
    if (err && err.code === '23505' && /uk_receta_producto_version/.test(err.constraint || '')) {
      const e = new Error('Otra receta de este producto se creo al mismo tiempo. Vuelve a intentar.');
      e.status = 409;
      throw e;
    }
    throw err;
  } finally {
    if (propia) conn.release();
  }
}

/**
 * Activa una receta. Antes valida que se pueda producir: insumos existentes,
 * sub-recetas vigentes y cobertura contra el stock real.
 */
async function activarReceta(id, usuario, opciones = {}) {
  const cliente = pool;
  const receta = await obtenerRecetaPorId(id, cliente);
  if (!receta) throw new Error('Receta no encontrada.');

  const valida = await validarLineas(receta.insumos.map(l => ({
    insumo_id: l.insumo_id,
    componente_receta_id: l.componente_receta_id,
    cantidad_por_caja: l.cantidad_por_caja,
    merma_pct: l.merma_pct,
    nombre: l.insumo_nombre,
    unidad: l.unidad_medida,
    obligatorio: l.obligatorio,
    notas: l.notas
  })), cliente);
  if (!valida.ok) {
    const e = new Error(valida.errores[0]);
    e.status = 400;
    throw e;
  }

  // El BOM se resuelve SIEMPRE, incluso forzando: un ciclo o un componente sin
  // receta vigente deja una receta que no se puede producir, y eso no lo arregla
  // la confirmacion de stock. `forzar` solo salta el aviso por falta de stock.
  // Se evalua ESTA receta, no la vigente, porque puede ser un borrador.
  const cajas = Number(opciones.cajas) || 1;
  let cobertura;
  try {
    cobertura = evaluarCobertura(await calcularInsumosDeReceta(receta, cajas, cliente), cajas);
  } catch (err) {
    const e = new Error(err.message);
    e.status = 400;
    throw e;
  }

  // Se puede activar una receta sin stock (puede producirse luego), pero NO se
  // activa sola: si falta un insumo obligatorio se devuelve el aviso y queda
  // pendiente de confirmacion explicita (`forzar`).
  let advertencia = null;
  let faltantes = [];
  if (!opciones.forzar) {
    faltantes = cobertura.filter(c => c.obligatorio && !c.alcanza);
    if (faltantes.length) {
      advertencia = 'Con el stock actual no alcanza para ' + cajas + ' caja(s): ' +
        faltantes.map(f => `${f.nombre} (stock ${f.disponible}, se piden ${f.solicitado})`).join('; ');
    }
  }

  if (advertencia) {
    return {
      success: false,
      requiere_confirmacion: true,
      receta,
      advertencia,
      faltantes: faltantes.map(f => `${f.nombre}: requiere ${f.solicitado} | stock: ${f.disponible}`),
      mensaje: `No se activo: ${advertencia}`
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user', $1, true)", [usuario || 'system']);
    await client.query('UPDATE recetas SET activa = false WHERE producto_key = $1 AND id <> $2', [receta.producto_key, id]);
    const r = await client.query(
      'UPDATE recetas SET activa = true, vigente_desde = CURRENT_DATE WHERE id = $1 RETURNING *',
      [id]
    );
    await client.query('COMMIT');
    return {
      success: true,
      requiere_confirmacion: false,
      receta: r.rows[0],
      advertencia: null,
      mensaje: 'Receta activada correctamente.'
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.code === '23505' && /uq_receta_vigente/.test(err.constraint || '')) {
      const e = new Error('Otra receta de este producto quedo activa al mismo tiempo. Recarga e intenta de nuevo.');
      e.status = 409;
      throw e;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function clonarRecetaParaEdicion(id, usuario, client = null) {
  const receta = await obtenerRecetaPorId(id, client || pool);
  if (!receta) throw new Error('Receta no encontrada.');
  return await crearReceta({
    producto_key: receta.producto_key,
    nombre_producto: receta.nombre_producto,
    insumos: receta.insumos.map(i => ({
      insumo_id: i.insumo_id,
      componente_receta_id: i.componente_receta_id,
      cantidad_por_caja: i.cantidad_por_caja,
      merma_pct: Number(i.merma_pct) || 0,
      stock_minimo: i.stock_minimo,
      unidad: i.unidad_medida,
      obligatorio: i.obligatorio,
      notas: i.notas
    })),
    observaciones: `Clon de v${receta.version} para edicion`,
    created_by: usuario
  }, client);
}

/** Diferencias entre la version vigente y una receta, para revisar antes de activar. */
async function diffReceta(id, db = pool) {
  const receta = await obtenerRecetaPorId(id, db);
  if (!receta) return null;
  const vigente = await obtenerRecetaVigente(receta.producto_key, db);

  const lineaDe = l => l.componente_receta_id
    ? `componente:${l.componente_receta_id}`
    : `insumo:${l.insumo_id}`;
  const mapaBase = new Map();
  const mapaNuevo = new Map();

  if (vigente) vigente.insumos.forEach(l => mapaBase.set(lineaDe(l), l));
  receta.insumos.forEach(l => mapaNuevo.set(lineaDe(l), l));

  const cambios = { agregados: [], quitados: [], modificados: [] };
  const resumen = l => ({
    clave: lineaDe(l),
    nombre: l.nombre_inventario || l.insumo_nombre,
    insumo_id: l.insumo_id,
    componente_receta_id: l.componente_receta_id,
    cantidad_por_caja: Number(l.cantidad_por_caja),
    merma_pct: Number(l.merma_pct) || 0,
    stock_minimo: l.stock_minimo,
    unidad: l.unidad_medida,
    obligatorio: l.obligatorio !== false,
    notas: l.notas
  });

  mapaNuevo.forEach((nuevo, clave) => {
    const base = mapaBase.get(clave);
    if (!base) {
      cambios.agregados.push(resumen(nuevo));
      return;
    }
    const campos = [];
    if (Number(base.cantidad_por_caja) !== Number(nuevo.cantidad_por_caja)) {
      campos.push({ campo: 'cantidad_por_caja', antes: Number(base.cantidad_por_caja), despues: Number(nuevo.cantidad_por_caja) });
    }
    if ((Number(base.merma_pct) || 0) !== (Number(nuevo.merma_pct) || 0)) {
      campos.push({ campo: 'merma_pct', antes: Number(base.merma_pct) || 0, despues: Number(nuevo.merma_pct) || 0 });
    }
    if (Number(base.stock_minimo || 0) !== Number(nuevo.stock_minimo || 0)) {
      campos.push({ campo: 'stock_minimo', antes: Number(base.stock_minimo) || 0, despues: Number(nuevo.stock_minimo) || 0 });
    }
    if (base.obligatorio !== nuevo.obligatorio) {
      campos.push({ campo: 'obligatorio', antes: base.obligatorio, despues: nuevo.obligatorio });
    }
    if ((base.unidad_medida || '') !== (nuevo.unidad_medida || '')) {
      campos.push({ campo: 'unidad', antes: base.unidad_medida, despues: nuevo.unidad_medida });
    }
    if ((base.notas || '') !== (nuevo.notas || '')) {
      campos.push({ campo: 'notas', antes: base.notas, despues: nuevo.notas });
    }
    if (campos.length) cambios.modificados.push({ ...resumen(nuevo), campos });
  });

  mapaBase.forEach((base, clave) => {
    if (!mapaNuevo.has(clave)) cambios.quitados.push(resumen(base));
  });

  return {
    receta_id: receta.id,
    producto_key: receta.producto_key,
    nombre: nombreDe(receta),
    version: receta.version,
    vigente: vigente ? { id: vigente.id, version: vigente.version } : null,
    cambios,
    hay_cambios: cambios.agregados.length + cambios.quitados.length + cambios.modificados.length > 0
  };
}

module.exports = {
  obtenerRecetaPorId,
  obtenerRecetaVigente,
  listarRecetas,
  crearReceta,
  activarReceta,
  clonarRecetaParaEdicion,
  calcularInsumosProduccion,
  calcularInsumosDeReceta,
  simularImpacto,
  evaluarCobertura,
  validarLineas,
  detectaCiclo,
  idsInsumosFaltantes,
  insumosFaltantesEnInventario,
  resolverNombresInventario,
  insertarLineas,
  siguienteVersion,
  diffReceta,
  nombreDe,
  PROFUNDIDAD_MAXIMA
};
