const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.post('/check-stock', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items?.length) return res.status(400).json({ success: false, mensaje: 'items[] requerido' });
    const resultados = await Promise.all(items.map(async ({ producto_key, cantidad, es_producto_terminado }) => {
      if (es_producto_terminado) {
        const pt = await pool.query('SELECT stock_cajas, stock_minimo FROM producto_terminado WHERE producto_key = $1', [producto_key]);
        const disp = pt.rows[0] ? Number(pt.rows[0].stock_cajas) : 0;
        return { producto_key, disponible: disp, minimo: pt.rows[0]?.stock_minimo || 0, solicitado: cantidad, ok: disp >= cantidad, tipo: 'producto_terminado' };
      } else {
        const inv = await pool.query('SELECT stock, stock_minimo FROM inventario WHERE LOWER(nombre) = LOWER($1)', [producto_key]);
        const disp = inv.rows[0] ? Number(inv.rows[0].stock) : 0;
        return { producto_key, disponible: disp, minimo: inv.rows[0]?.stock_minimo || 0, solicitado: cantidad, ok: disp >= cantidad, tipo: 'insumo' };
      }
    }));
    res.json({ success: true, items: resultados, todos_ok: resultados.every(r => r.ok) });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

router.get('/stock-bajo', async (req, res) => {
  try {
    const [insumos, pt] = await Promise.all([
      pool.query('SELECT id, nombre, stock, stock_minimo, unidad_medida, categoria FROM inventario WHERE stock_minimo > 0 AND stock <= stock_minimo ORDER BY (stock::numeric / NULLIF(stock_minimo, 0)) ASC'),
      pool.query('SELECT id, producto_key, nombre_producto, stock_cajas, stock_minimo FROM producto_terminado WHERE stock_minimo > 0 AND stock_cajas <= stock_minimo ORDER BY (stock_cajas::numeric / NULLIF(stock_minimo, 0)) ASC')
    ]);
    res.json({ success: true, insumos: insumos.rows.map(r => ({ ...r, tipo: 'insumo' })), productos_terminados: pt.rows.map(r => ({ ...r, tipo: 'producto_terminado' })) });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
});

module.exports = router;