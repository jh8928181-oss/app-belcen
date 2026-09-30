const express = require('express');
const router = express.Router();
const recipeService = require('../services/recipeService');
const db = require('../db');
const { authMiddleware, crearGuardRoles } = require('../middleware/auth');

const TAPA_DEFECTO_RECETA = 'Tapa dosif. N° 26 blanco / Dorado';

// Lectura: cualquier usuario autenticado. Escritura: solo admin y con bloqueo
// inmediato (no queda en modo observacion): una receta activa gobierna lo que
// descuenta produccion del stock real.
const soloAdmin = crearGuardRoles(['admin'], {
  enforce: true,
  mensaje: 'Solo el administrador puede gestionar recetas.'
});

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

// Impacto de UNA receta concreta antes de activarla: cobertura, cascada y
// dependencias. Se simula la version del id (tambien un borrador), no la vigente.
router.get('/:id/impacto', async (req, res) => {
  try {
    const receta = await recipeService.obtenerRecetaPorId(req.params.id);
    if (!receta) return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' });
    const cajas = req.query.cajas === undefined ? 1 : Number(req.query.cajas);
    if (!Number.isFinite(cajas) || !(cajas > 0)) {
      return res.status(400).json({ success: false, mensaje: 'cajas debe ser un numero mayor que 0' });
    }
    const impacto = await recipeService.simularImpacto(receta.producto_key, cajas, db, receta.id);
    if (!impacto) return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' });
    res.json({ success: true, impacto });
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
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
      const impacto = await recipeService.simularImpacto(producto_key, cajasRaw);
      if (!impacto) return res.status(404).json({ success: false, mensaje: 'No hay receta vigente para este producto' });
      return res.json({
        success: true,
        producto_tipo: producto_key,
        cajas: cajasRaw,
        requiere_selector_tapa: false,
        tapa_por_defecto: TAPA_DEFECTO_RECETA,
        // Se mantiene insumos con la forma que el simulador ya esperaba.
        insumos: impacto.insumos.map(i => ({
          nombre: i.nombre,
          cantidad: Number(Number(i.cantidad).toFixed(6)),
          cantidad_por_caja: i.cantidad_por_caja,
          unidad_medida: i.unidad,
          insumo_id: i.insumo_id,
          obligatorio: i.obligatorio,
          stock_actual: i.stock_actual,
          tapa_dinamica: false
        })),
        cobertura: impacto.cobertura,
        faltantes: impacto.faltantes,
        cajas_maximas: impacto.cajas_maximas,
        advertencias: impacto.advertencias.concat(impacto.despues)
      });
    }

    res.json({ success: true, receta });
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

/**
 * Normaliza y valida las lineas que llegan del formulario.
 * Traduce un nombre de insumo a su id de inventario y descarta lo que no exista:
 * desde la migracion las lineas guardan el id, no el nombre tecleado.
 */
async function prepararLineas(bruto, db_ = db) {
  const lineas = Array.isArray(bruto) ? bruto : [];
  const ids = lineas.map(l => (l && (l.insumo_id || l.id)) || null).filter(Boolean);
  const porId = await recipeService.resolverNombresInventario(ids.map(Number), db_);

  const preparadas = [];
  for (const [i, l] of lineas.entries()) {
    if (!l) { preparadas.push(null); continue; }
    const n = i + 1;
    const subId = l.componente_receta_id ? Number(l.componente_receta_id) : null;

    if (subId) {
      const sub = await db_.query('SELECT producto_key, nombre_producto FROM recetas WHERE id = $1', [subId]);
      if (!sub.rows.length) throw Object.assign(new Error(`Linea ${n}: el componente ya no existe.`), { status: 400 });
      preparadas.push({
        componente_receta_id: subId,
        nombre: sub.rows[0].nombre_producto || sub.rows[0].producto_key,
        cantidad_por_caja: Number(l.cantidad_por_caja),
        merma_pct: Number(l.merma_pct || 0),
        stock_minimo: l.stock_minimo === '' || l.stock_minimo === null || l.stock_minimo === undefined
          ? null : Number(l.stock_minimo),
        unidad: l.unidad || 'UNIDADES',
        obligatorio: l.obligatorio !== false,
        notas: l.notas || ''
      });
      continue;
    }

    const invId = Number(l.insumo_id || l.id);
    const inv = porId.get(invId);
    if (!inv) {
      throw Object.assign(
        new Error(`Linea ${n}: elige un insumo del catalogo de inventario.`),
        { status: 400 }
      );
    }
    const merma = Number(l.merma_pct || 0);
    if (!(merma >= 0 && merma < 100)) {
      throw Object.assign(new Error(`Linea ${n}: la merma debe estar entre 0 y 99.99 % (${inv.nombre}).`), { status: 400 });
    }
    const cantidad = Number(l.cantidad_por_caja);
    if (!(cantidad > 0)) {
      throw Object.assign(new Error(`Linea ${n}: la cantidad por caja de "${inv.nombre}" debe ser mayor que 0.`), { status: 400 });
    }
    const sm = l.stock_minimo === '' || l.stock_minimo === null || l.stock_minimo === undefined
      ? null : Number(l.stock_minimo);
    if (sm !== null && !(sm >= 0)) {
      throw Object.assign(new Error(`Linea ${n}: el stock de seguridad de "${inv.nombre}" no puede ser negativo.`), { status: 400 });
    }

    preparadas.push({
      insumo_id: invId,
      nombre: inv.nombre,
      cantidad_por_caja: cantidad,
      merma_pct: merma,
      stock_minimo: sm,
      unidad: l.unidad || inv.unidad_medida || 'UNIDADES',
      obligatorio: l.obligatorio !== false,
      notas: l.notas || ''
    });
  }
  return preparadas.filter(Boolean);
}

// Crear receta. Acepta productos que aun no estan en el catalogo de terminados:
// se registra la receta igual, y el nombre legible vive en recetas.nombre_producto.
// Nace siempre como borrador: activar es otro paso (PUT /:id/activar) porque es
// el que revisa el stock antes de dejar que una receta gobierne produccion.
router.post('/', soloAdmin, async (req, res) => {
  try {
    const { producto_key, nombre_producto, insumos, observaciones } = req.body;
    if (!producto_key || !String(producto_key).trim()) {
      return res.status(400).json({ success: false, mensaje: 'producto_key requerido' });
    }
    const lineas = await prepararLineas(insumos);
    const valida = await recipeService.validarLineas(lineas);
    if (!valida.ok) {
      return res.status(400).json({ success: false, mensaje: valida.errores[0], errores: valida.errores });
    }
    const receta = await recipeService.crearReceta({
      producto_key: String(producto_key).trim(),
      nombre_producto,
      insumos: lineas,
      observaciones,
      created_by: req.usuario
    });
    res.status(201).json({
      success: true,
      mensaje: 'Receta creada como borrador. Activala cuando quieras que gobierne produccion.',
      receta
    });
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

/** Insumos de una receta en la forma que espera el formulario. */
function lineasParaFormulario(receta) {
  return receta.insumos.map(l => ({
    insumo_id: l.insumo_id,
    componente_receta_id: l.componente_receta_id,
    nombre: l.nombre_inventario || l.insumo_nombre,
    sub_nombre: l.sub_nombre_producto,
    sub_producto_key: l.sub_producto_key,
    cantidad_por_caja: Number(l.cantidad_por_caja),
    merma_pct: Number(l.merma_pct) || 0,
    stock_minimo: l.stock_minimo === null ? '' : Number(l.stock_minimo),
    unidad: l.unidad_inventario || l.unidad_medida,
    categoria: l.categoria_inventario || '',
    stock_actual: l.stock_actual === null || l.stock_actual === undefined ? null : Number(l.stock_actual),
    obligatorio: l.obligatorio !== false,
    notas: l.notas || ''
  }));
}

// Edicion libre. Si la receta esta activa, los cambios se guardan en un borrador
// y la activa no se toca: produccion sigue calculando con lo que ya estaba.
router.put('/:id', soloAdmin, async (req, res) => {
  try {
    // `forzar` no se lee aqui a proposito: el guardado nunca fuerza activacion.
    const { insumos, observaciones, activa, activar, motivo } = req.body;

    const actual = await recipeService.obtenerRecetaPorId(req.params.id);
    if (!actual) return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' });

    const cliente = await db.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query("SELECT set_config('app.current_user', $1, true)", [req.usuario || 'system']);

      let destino = actual;
      let redirigido = false;

      // Editar el contenido de una receta activa NUNCA la toca: se trabaja sobre
      // el borrador. `forzar` solo sirve para confirmar una activacion sin stock,
      // asi que no puede servir para saltarse esta regla.
      if (actual.activa && (insumos?.length || observaciones !== undefined)) {
        const existente = await cliente.query(
          'SELECT id FROM recetas WHERE producto_key = $1 AND activa = false ORDER BY version DESC LIMIT 1',
          [actual.producto_key]
        );
        destino = existente.rows.length
          ? await recipeService.obtenerRecetaPorId(existente.rows[0].id, cliente)
          : await recipeService.clonarRecetaParaEdicion(actual.id, req.usuario, cliente);
        redirigido = true;
      }

      const lineas = insumos?.length ? await prepararLineas(insumos, cliente) : null;

      if (lineas) {
        const valida = await recipeService.validarLineas(lineas, cliente);
        if (!valida.ok) {
          await cliente.query('ROLLBACK');
          return res.status(400).json({ success: false, mensaje: valida.errores[0], errores: valida.errores });
        }
        if (await recipeService.detectaCiclo(destino.id, lineas.map(l => l.componente_receta_id), cliente)) {
          await cliente.query('ROLLBACK');
          return res.status(400).json({ success: false, mensaje: 'Ese componente crearia un ciclo de recetas. Elige otro.' });
        }

        // El trigger de auditoria solo ve UPDATE sobre recetas: la diferencia de
        // insumos se registra aqui, que es donde se conoce la intencion.
        const antes = new Map(destino.insumos.map(l => [l.componente_receta_id ? `c${l.componente_receta_id}` : `i${l.insumo_id}`, l]));
        const despues = new Map(lineas.map(l => [l.componente_receta_id ? `c${l.componente_receta_id}` : `i${l.insumo_id}`, l]));
        const diff = {
          agregados: [...despues.keys()].filter(k => !antes.has(k)),
          quitados: [...antes.keys()].filter(k => !despues.has(k)),
          modificados: [...despues.keys()]
            .filter(k => antes.has(k))
            .filter(k => Number(antes.get(k).cantidad_por_caja) !== Number(despues.get(k).cantidad_por_caja) ||
                         Number(antes.get(k).merma_pct || 0) !== Number(despues.get(k).merma_pct || 0) ||
                         Number(antes.get(k).stock_minimo || 0) !== Number(despues.get(k).stock_minimo || 0) ||
                         antes.get(k).obligatorio !== despues.get(k).obligatorio)
        };

        await cliente.query('DELETE FROM receta_insumos WHERE receta_id = $1', [destino.id]);
        await recipeService.insertarLineas(cliente, destino.id, lineas, destino.producto_key);

        await cliente.query(
          `INSERT INTO historial_recetas (receta_id, accion, usuario_ejecutor, valores_nuevos, diff)
           VALUES ($1,'EDITAR_INSUMOS',$2,$3,$4)`,
          [destino.id, req.usuario || 'system', JSON.stringify({ motivo: motivo || null, lineas: lineas.length }), JSON.stringify(diff)]
        );
      }

      if (observaciones !== undefined) {
        await cliente.query('UPDATE recetas SET observaciones = $1 WHERE id = $2', [observaciones, destino.id]);
      }
      if (activa === false) {
        await cliente.query('UPDATE recetas SET activa = false, vigente_hasta = CURRENT_DATE WHERE id = $1', [destino.id]);
      }

      await cliente.query('COMMIT');

      let mensaje = redirigido
        ? 'Cambios guardados en el borrador. La receta activa sigue vigente hasta que actives el borrador.'
        : 'Receta actualizada.';
      let recetaRespuesta = await recipeService.obtenerRecetaPorId(destino.id);

      if (activar === true) {
        // La activacion se valida por separado y NUNCA se fuerza aqui: `forzar`
        // solo existe en PUT /:id/activar, que es el paso de confirmacion. Asi el
        // usuario siempre ve el aviso de faltantes antes desaltarse la cobertura.
        const act = await recipeService.activarReceta(destino.id, req.usuario, { forzar: false });
        if (!act.success) {
          return res.status(409).json({
            ...act,
            mensaje: `${mensaje} No se activo: ${act.advertencia}`,
            aplicado: !redirigido,
            redirigida_a_borrador: redirigido,
            receta: recetaRespuesta
          });
        }
        recetaRespuesta = await recipeService.obtenerRecetaPorId(destino.id);
        mensaje = `${mensaje} ${act.mensaje}`;
      }

      res.json({
        success: true,
        mensaje,
        aplicado: !redirigido,
        redirigida_a_borrador: redirigido,
        receta: recetaRespuesta,
        lineas: lineasParaFormulario(recetaRespuesta)
      });
    } catch (err) {
      await cliente.query('ROLLBACK');
      throw err;
    } finally { cliente.release(); }
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

router.put('/:id/activar', soloAdmin, async (req, res) => {
  try {
    const resultado = await recipeService.activarReceta(req.params.id, req.usuario, {
      forzar: req.body?.forzar === true,
      cajas: Number(req.body?.cajas) || 1
    });
    if (!resultado.success) {
      return res.status(409).json(resultado);
    }
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

router.post('/:id/clonar', soloAdmin, async (req, res) => {
  try {
    const receta = await recipeService.clonarRecetaParaEdicion(req.params.id, req.usuario);
    res.status(201).json({ success: true, mensaje: 'Receta clonada para edición', receta });
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

// Diferencias entre el borrador y la version vigente, para revisar antes de activar.
router.get('/:id/diff', async (req, res) => {
  try {
    const diff = await recipeService.diffReceta(req.params.id);
    if (!diff) return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' });
    res.json({ success: true, diff });
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

router.delete('/:id', soloAdmin, async (req, res) => {
  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user', $1, true)", [req.usuario || 'system']);
      const act = await client.query('SELECT activa FROM recetas WHERE id = $1', [req.params.id]);
      if (!act.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, mensaje: 'Receta no encontrada' }); }
      if (act.rows[0].activa) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, mensaje: 'Desactívala primero' }); }
      // Registro de auditoría: captura el estado (receta + insumos) antes de borrar.
      // receta_id queda como referencia al id eliminado (ids seriales no se reutilizan).
      const payload = await client.query('SELECT to_jsonb(r) || jsonb_build_object(\'insumos\', (SELECT jsonb_agg(to_jsonb(ri)) FROM receta_insumos ri WHERE ri.receta_id = r.id)) AS v FROM recetas r WHERE r.id = $1', [req.params.id]);
      await client.query('INSERT INTO historial_recetas (receta_id, accion, usuario_ejecutor, valores_anteriores) VALUES ($1, \'DELETE\', $2, $3)', [req.params.id, req.usuario || 'system', payload.rows[0]?.v || '{}']);
      await client.query('DELETE FROM receta_insumos WHERE receta_id = $1', [req.params.id]);
      await client.query('DELETE FROM recetas WHERE id = $1', [req.params.id]);
      await client.query('COMMIT');
      res.json({ success: true, mensaje: 'Eliminada' });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

router.get('/:producto_key/calcular', async (req, res) => {
  try {
    const cajas = parseInt(req.query.cajas, 10);
    if (!cajas || cajas <= 0) return res.status(400).json({ success: false, mensaje: 'cajas > 0 requerido' });
    const insumos = await recipeService.calcularInsumosProduccion(req.params.producto_key, cajas);
    if (!insumos.length) return res.status(404).json({ success: false, mensaje: 'No hay receta vigente para este producto' });
    const cobertura = recipeService.evaluarCobertura(insumos, cajas);
    res.json({ success: true, insumos, cobertura, total_insumos: insumos.length });
  } catch (err) { res.status(err.status || 500).json({ success: false, mensaje: err.message }); }
});

module.exports = router;
