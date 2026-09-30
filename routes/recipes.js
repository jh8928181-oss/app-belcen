const express = require('express');
const router = express.Router();
const recipeService = require('../services/recipeService');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const TAPA_DEFECTO_RECETA = 'Tapa dosif. N° 26 blanco / Dorado';

router.use(authMiddleware);

// Catálogo (compatibilidad con el simulador) + lista de recetas para el módulo de gestión
router.get('/', async (req, res) => {
  try {
    const recetas = await recipeService.listarRecetas();
    res.json({
      success: true,
      recetas,
      productos_tapa_dinamica: [],
      tapa_por_defecto: TAPA_DEFECTO_RECETA
    });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

// Detalle por id (debe ir antes de /:producto_key para no capturar 'detalle')
router.get('/detalle/:id', async (req, res) => {
  try {
    const receta = await recipeService.obtenerRecetaPorId(req.params.id);
    if (!receta) return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' });
    res.json({ success: true, receta });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

// Receta vigente o cálculo simulador por producto (?cajas=N)
router.get('/:producto_key', async (req, res) => {
  try {
    const { producto_key } = req.params;
    const cajasRaw = parseFloat(req.query.cajas);

    const receta = await recipeService.obtenerRecetaVigente(producto_key);
    if (!receta) return res.status(404).json({ success: false, mensaje: 'No hay receta vigente para este producto' });

    // Modo simulador (compatible con frontend existente)
    if (!isNaN(cajasRaw) && cajasRaw > 0) {
      const insumos = receta.insumos.map(ri => ({
        nombre: ri.insumo_nombre,
        cantidad: Number(ri.cantidad_por_caja) * cajasRaw,
        cantidad_por_caja: Number(ri.cantidad_por_caja),
        unidad_medida: ri.unidad_medida,
        obligatorio: ri.obligatorio,
        tapa_dinamica: false
      }));
      return res.json({
        success: true,
        producto_tipo: producto_key,
        cajas: cajasRaw,
        requiere_selector_tapa: false,
        tapa_por_defecto: TAPA_DEFECTO_RECETA,
        insumos
      });
    }

    res.json({ success: true, receta });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

// Crear receta (borrador)
router.post('/', async (req, res) => {
  try {
    const { producto_key, insumos, observaciones } = req.body;
    if (!producto_key || !insumos?.length) return res.status(400).json({ success: false, mensaje: 'producto_key e insumos[] requeridos' });
    for (const insumo of insumos) {
      if (!insumo?.nombre || !(parseFloat(insumo.cantidad_por_caja) > 0)) {
        return res.status(400).json({ success: false, mensaje: 'Cada insumo debe tener nombre y cantidad_por_caja > 0' });
      }
      const existe = await db.query('SELECT 1 FROM inventario WHERE LOWER(nombre) = LOWER($1)', [insumo.nombre]);
      if (!existe.rows.length) return res.status(400).json({ success: false, mensaje: `Insumo "${insumo.nombre}" no existe en inventario` });
    }
    const receta = await recipeService.crearReceta({ producto_key, insumos, observaciones, created_by: req.usuario });
    res.status(201).json({ success: true, mensaje: 'Receta creada (borrador)', receta });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.put('/:id/activar', async (req, res) => {
  try { const result = await recipeService.activarReceta(req.params.id, req.usuario); res.json(result); }
  catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.post('/:id/clonar', async (req, res) => {
  try { const receta = await recipeService.clonarRecetaParaEdicion(req.params.id, req.usuario); res.status(201).json({ success: true, mensaje: 'Receta clonada para edición', receta }); }
  catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { insumos, observaciones, activa, forzar } = req.body;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL app.current_user = $1', [req.usuario || 'system']);
      const actual = await client.query('SELECT * FROM recetas WHERE id = $1', [req.params.id]);
      if (!actual.rows.length) return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' });
      if (actual.rows[0].activa && !forzar) return res.status(400).json({ success: false, mensaje: 'Receta activa. Clónala o usa forzar=true' });
      if (observaciones !== undefined) await client.query('UPDATE recetas SET observaciones = $1 WHERE id = $2', [observaciones, req.params.id]);
      if (activa !== undefined) {
        if (activa) await client.query('UPDATE recetas SET activa = false WHERE producto_key = (SELECT producto_key FROM recetas WHERE id = $1) AND id != $1', [req.params.id]);
        await client.query('UPDATE recetas SET activa = $1, vigente_desde = CASE WHEN $1 THEN CURRENT_DATE ELSE vigente_desde END WHERE id = $2', [activa, req.params.id]);
      }
      if (insumos?.length) {
        for (const insumo of insumos) {
          const existe = await db.query('SELECT 1 FROM inventario WHERE LOWER(nombre) = LOWER($1)', [insumo.nombre]);
          if (!existe.rows.length) return res.status(400).json({ success: false, mensaje: `Insumo "${insumo.nombre}" no existe en inventario` });
        }
        await client.query('DELETE FROM receta_insumos WHERE receta_id = $1', [req.params.id]);
        for (const [index, insumo] of insumos.entries()) {
          await client.query('INSERT INTO receta_insumos (receta_id, insumo_nombre, cantidad_por_caja, unidad_medida, obligatorio, orden, notas) VALUES ($1,$2,$3,$4,$5,$6,$7)', [req.params.id, insumo.nombre, insumo.cantidad_por_caja, insumo.unidad || 'UNIDADES', insumo.obligatorio !== false, index, insumo.notas || '']);
        }
      }
      await client.query('COMMIT');
      const receta = await recipeService.obtenerRecetaPorId(req.params.id);
      res.json({ success: true, mensaje: 'Actualizada', receta });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL app.current_user = $1', [req.usuario || 'system']);
      const act = await client.query('SELECT activa FROM recetas WHERE id = $1', [req.params.id]);
      if (!act.rows.length) return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' });
      if (act.rows[0].activa) return res.status(400).json({ success: false, mensaje: 'Desactívala primero' });
      await client.query('DELETE FROM receta_insumos WHERE receta_id = $1', [req.params.id]);
      await client.query('DELETE FROM recetas WHERE id = $1', [req.params.id]);
      await client.query('COMMIT');
      res.json({ success: true, mensaje: 'Eliminada' });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.get('/:producto_key/calcular', async (req, res) => {
  try {
    const cajas = parseInt(req.query.cajas, 10);
    if (!cajas || cajas <= 0) return res.status(400).json({ success: false, mensaje: 'cajas > 0 requerido' });
    const insumos = await recipeService.calcularInsumosProduccion(req.params.producto_key, cajas, req.query.tapa || null);
    if (!insumos.length) return res.status(404).json({ success: false, mensaje: 'No hay receta vigente para este producto' });
    res.json({ success: true, insumos, total_insumos: insumos.length });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

module.exports = router;