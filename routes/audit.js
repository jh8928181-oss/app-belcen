const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware, crearGuardRoles } = require('../middleware/auth');

const gAuditoria = crearGuardRoles(['admin', 'supervisor', 'auditoria', 'produccion'], { enforce: true });
router.use(authMiddleware);
router.use(gAuditoria);

router.get('/accesos', async (req, res) => {
  try {
    const { usuario, accion, exito, desde, hasta, q, limit = 500, offset = 0 } = req.query;
    const params = [], filtros = [];
    if (usuario) { params.push(usuario); filtros.push(`usuario ILIKE $${params.length}`); }
    if (accion) { params.push(accion); filtros.push(`accion = $${params.length}`); }
    if (exito !== undefined) { params.push(exito === 'true'); filtros.push(`exito = $${params.length}`); }
    if (desde) { params.push(desde); filtros.push(`fecha >= $${params.length}`); }
    if (hasta) { params.push(hasta + ' 23:59:59'); filtros.push(`fecha <= $${params.length}`); }
    if (q) { params.push(`%${q}%`); filtros.push(`(usuario ILIKE $${params.length} OR mensaje_error ILIKE $${params.length})`); }
    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    params.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(`SELECT * FROM historial_accesos ${where} ORDER BY fecha DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const total = await pool.query(`SELECT COUNT(*) FROM historial_accesos ${where}`, params.slice(0, -2));
    res.json({ success: true, data: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.get('/usuarios', async (req, res) => {
  try { const { usuario_afectado, accion, desde, hasta, limit = 500, offset = 0 } = req.query; const params = [], filtros = []; if (usuario_afectado) { params.push(usuario_afectado); filtros.push(`usuario_afectado ILIKE $${params.length}`); } if (accion) { params.push(accion); filtros.push(`accion = $${params.length}`); } if (desde) { params.push(desde); filtros.push(`fecha >= $${params.length}`); } if (hasta) { params.push(hasta + ' 23:59:59'); filtros.push(`fecha <= $${params.length}`); } const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''; params.push(parseInt(limit), parseInt(offset)); const result = await pool.query(`SELECT * FROM historial_usuarios ${where} ORDER BY fecha DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params); const total = await pool.query(`SELECT COUNT(*) FROM historial_usuarios ${where}`, params.slice(0, -2)); res.json({ success: true, data: result.rows, total: parseInt(total.rows[0].count) }); } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.get('/recetas', async (req, res) => {
  try { const { receta_id, accion, desde, hasta, limit = 500, offset = 0 } = req.query; const params = [], filtros = []; if (receta_id) { params.push(receta_id); filtros.push(`receta_id = $${params.length}`); } if (accion) { params.push(accion); filtros.push(`accion = $${params.length}`); } if (desde) { params.push(desde); filtros.push(`fecha >= $${params.length}`); } if (hasta) { params.push(hasta + ' 23:59:59'); filtros.push(`fecha <= $${params.length}`); } const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''; params.push(parseInt(limit), parseInt(offset)); const result = await pool.query(`SELECT * FROM historial_recetas ${where} ORDER BY fecha DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params); const total = await pool.query(`SELECT COUNT(*) FROM historial_recetas ${where}`, params.slice(0, -2)); res.json({ success: true, data: result.rows, total: parseInt(total.rows[0].count) }); } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.get('/export', async (req, res) => {
  try { const { tabla, desde, hasta } = req.query; const permitidas = ['historial_accesos', 'historial_usuarios', 'historial_recetas', 'historial_inventario']; if (!permitidas.includes(tabla)) return res.status(400).json({ success: false, mensaje: 'Tabla inválida' }); const params = [], filtros = []; if (desde) { params.push(desde); filtros.push(`fecha >= $${params.length}`); } if (hasta) { params.push(hasta + ' 23:59:59'); filtros.push(`fecha <= $${params.length}`); } const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''; const result = await pool.query(`SELECT * FROM ${tabla} ${where} ORDER BY fecha DESC`, params); if (!result.rows.length) return res.status(404).send('Sin datos'); const headers = Object.keys(result.rows[0]); const csv = [headers.join(','), ...result.rows.map(r => headers.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))].join('\n'); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${tabla}_${new Date().toISOString().split('T')[0]}.csv"`); res.send('\uFEFF' + csv); } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

module.exports = router;