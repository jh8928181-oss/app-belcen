const pool = require('../db');

async function obtenerRecetaVigente(producto_key, db = pool) {
  const receta = await db.query(`
    SELECT r.id, r.producto_key, r.version, r.vigente_desde, r.vigente_hasta, 
           r.activa, r.observaciones, r.created_by, r.created_at
    FROM recetas r
    WHERE r.producto_key = $1 
      AND r.activa = true
      AND r.vigente_desde <= CURRENT_DATE
      AND (r.vigente_hasta IS NULL OR r.vigente_hasta >= CURRENT_DATE)
    ORDER BY r.version DESC LIMIT 1
  `, [producto_key]);
  if (!receta.rows.length) return null;
  const insumos = await db.query(`
    SELECT ri.id, ri.insumo_nombre, ri.cantidad_por_caja, ri.unidad_medida,
           ri.obligatorio, ri.orden, ri.notas
    FROM receta_insumos ri WHERE ri.receta_id = $1 ORDER BY ri.orden
  `, [receta.rows[0].id]);
  return { ...receta.rows[0], insumos: insumos.rows };
}

async function calcularInsumosProduccion(producto_key, cajas, _tapa_elegida = null, db = pool) {
  const receta = await obtenerRecetaVigente(producto_key, db);
  if (!receta) return [];
  return receta.insumos.map(ri => ({
    nombre: ri.insumo_nombre,
    cantidad: Number(ri.cantidad_por_caja) * cajas,
    unidad: ri.unidad_medida,
    obligatorio: ri.obligatorio,
    receta_insumo_id: ri.id
  }));
}

async function listarRecetas() {
  const result = await pool.query(`
    SELECT r.*, pt.nombre_producto,
           (SELECT COUNT(*) FROM receta_insumos ri WHERE ri.receta_id = r.id) as num_insumos
    FROM recetas r
    JOIN producto_terminado pt ON pt.producto_key = r.producto_key
    ORDER BY r.producto_key, r.version DESC
  `);
  return result.rows;
}

async function obtenerRecetaPorId(id) {
  const receta = await pool.query('SELECT * FROM recetas WHERE id = $1', [id]);
  if (!receta.rows.length) return null;
  const insumos = await pool.query('SELECT * FROM receta_insumos WHERE receta_id = $1 ORDER BY orden', [id]);
  return { ...receta.rows[0], insumos: insumos.rows };
}

async function crearReceta({ producto_key, insumos, observaciones, created_by }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL app.current_user = $1', [created_by || 'system']);
    const versionRes = await client.query('SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM recetas WHERE producto_key = $1', [producto_key]);
    const version = versionRes.rows[0].next_version;
    const recetaRes = await client.query(`
      INSERT INTO recetas (producto_key, version, observaciones, created_by, activa)
      VALUES ($1, $2, $3, $4, false) RETURNING *
    `, [producto_key, version, observaciones || '', created_by]);
    const recetaId = recetaRes.rows[0].id;
    for (const [index, insumo] of insumos.entries()) {
      await client.query(`
        INSERT INTO receta_insumos (receta_id, insumo_nombre, cantidad_por_caja, unidad_medida, obligatorio, orden, notas)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [recetaId, insumo.nombre, insumo.cantidad_por_caja, insumo.unidad, insumo.obligatorio !== false, index, insumo.notas || '']);
    }
    await client.query('COMMIT');
    return await obtenerRecetaPorId(recetaId);
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function activarReceta(id, usuario) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL app.current_user = $1', [usuario || 'system']);
    const receta = await client.query('SELECT producto_key FROM recetas WHERE id = $1', [id]);
    if (!receta.rows.length) throw new Error('Receta no encontrada');
    await client.query('UPDATE recetas SET activa = false WHERE producto_key = $1 AND id != $2', [receta.rows[0].producto_key, id]);
    await client.query('UPDATE recetas SET activa = true, vigente_desde = CURRENT_DATE WHERE id = $1 RETURNING *', [id]);
    await client.query('COMMIT');
    return { success: true, mensaje: 'Receta activada correctamente' };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function clonarRecetaParaEdicion(id, usuario) {
  const receta = await obtenerRecetaPorId(id);
  if (!receta) throw new Error('Receta no encontrada');
  return await crearReceta({
    producto_key: receta.producto_key,
    insumos: receta.insumos.map(i => ({ nombre: i.insumo_nombre, cantidad_por_caja: i.cantidad_por_caja, unidad: i.unidad_medida, obligatorio: i.obligatorio, notas: i.notas })),
    observaciones: `Clon de v${receta.version} para edición`,
    created_by: usuario
  });
}

module.exports = { obtenerRecetaVigente, calcularInsumosProduccion, listarRecetas, obtenerRecetaPorId, crearReceta, activarReceta, clonarRecetaParaEdicion };