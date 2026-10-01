/**
 * API del mapa de flujo de trabajo (public/flujo.html).
 *
 * Acceso: solo la cuenta admin1, y por nombre de usuario, no por rol. admin1
 * comparte rol 'admin' con otras cuentas, asi que un guard por rol no lo
 * distinguiria; por eso se usa crearGuardUsuarios con enforce:true, que da 403
 * de verdad en vez de un aviso en consola.
 *
 * Metricas: se calculan con una lista blanca de conteos con nombre. El cliente
 * nunca envia SQL, solo recibe { clave, valor } y lo pinta en el nodo que tenga
 * esa clave en su campo `metrica`. Añadir una metrica nueva es añadir una linea
 * a METRICAS, no tocar el cliente.
 */

const express = require('express');
const db = require('../db');
const { authMiddleware, crearGuardUsuarios } = require('../middleware/auth');

const router = express.Router();

const USUARIOS_FLUJO = ['admin1'];

const soloAdmin1 = crearGuardUsuarios(USUARIOS_FLUJO, {
  enforce: true,
  mensaje: 'El mapa de flujo es exclusivo del usuario admin1.'
});

const TIPOS_CONEXION = ['normal', 'decision', 'rechazo'];
const MAX_NODOS = 200;
const RE_CLAVE = /^[A-Za-z0-9_-]{2,50}$/;
const RE_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Catalogo de metricas que el cliente puede asignar a un nodo. El SQL de cada
 * una vive en SQL_METRICAS, con el mismo orden que este array.
 */
const METRICAS = [
  { clave: 'oc_activas', etiqueta: 'OC activas' },
  { clave: 'os_activas', etiqueta: 'OS activas' },
  { clave: 'ordenes_recibidas', etiqueta: 'Órdenes recibidas' },
  { clave: 'proveedores', etiqueta: 'Proveedores' },
  { clave: 'pendientes_vigilancia', etiqueta: 'Pendientes de conformidad' },
  { clave: 'ingresos_almacen', etiqueta: 'Ingresos registrados' },
  { clave: 'inventario_items', etiqueta: 'Artículos en inventario' },
  { clave: 'inventario_bajo_stock', etiqueta: 'Bajo stock' },
  { clave: 'salidas', etiqueta: 'Salidas registradas' },
  { clave: 'salidas_pendientes', etiqueta: 'Salidas por regularizar' },
  { clave: 'movimientos_inventario', etiqueta: 'Movimientos de inventario' },
  { clave: 'stock_proveedores_items', etiqueta: 'Items de proveedor' },
  { clave: 'stock_proveedores_mov', etiqueta: 'Movimientos de proveedor' },
  { clave: 'soplado_reportes', etiqueta: 'Reportes de soplado' },
  { clave: 'produccion_reportes', etiqueta: 'Reportes de producción' },
  { clave: 'refinado_reportes', etiqueta: 'Reportes de refinado' },
  { clave: 'refinado_stock_items', etiqueta: 'Insumos de refinado' },
  { clave: 'receta_vigentes', etiqueta: 'Recetas vigentes' },
  { clave: 'producto_terminado_items', etiqueta: 'Presentaciones en stock' },
  { clave: 'lineas_marcha', etiqueta: 'Líneas en marcha' }
];

const CLAVES_METRICAS = new Set(METRICAS.map((m) => m.clave));

router.use(authMiddleware);
router.use(soloAdmin1);

// ---------- VALIDACION ----------

function texto(valor, tope) {
  return String(valor === undefined || valor === null ? '' : valor).trim().slice(0, tope);
}

/**
 * Normaliza y valida un nodo. Devuelve { ok, datos } o { ok:false, mensaje }.
 * Todas las reglas viven aqui para que POST, PUT y el guardado masivo apliquen
 * exactamente la misma.
 */
function validarNodo(bruto) {
  const b = bruto || {};
  const clave = texto(b.clave, 50);
  const nombre = texto(b.nombre, 120);

  if (!nombre) return { ok: false, mensaje: 'El nombre del nodo es obligatorio.' };
  if (!RE_CLAVE.test(clave)) {
    return { ok: false, mensaje: 'La clave del nodo debe tener entre 2 y 50 caracteres (letras, números, guion y guion bajo).' };
  }

  const color = texto(b.color, 20) || '#38bdf8';
  if (!RE_COLOR.test(color)) return { ok: false, mensaje: 'El color debe ser un hexadecimal de 6 dígitos, por ejemplo #38bdf8.' };

  const metrica = texto(b.metrica, 60) || null;
  if (metrica && !CLAVES_METRICAS.has(metrica)) {
    return { ok: false, mensaje: `Métrica desconocida: "${metrica}".` };
  }

  // Acotar la geometria evita que un valor absurdo desplace el nodo fuera del
  // lienzo y lo vuelva inalcanzable sin editar la base a mano.
  const x = Number(b.x);
  const y = Number(b.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, mensaje: 'Las coordenadas del nodo deben ser números.' };
  }
  if (Math.abs(x) > 100000 || Math.abs(y) > 100000) {
    return { ok: false, mensaje: 'Las coordenadas del nodo están fuera de rango.' };
  }

  return {
    ok: true,
    datos: {
      clave,
      nombre,
      area: texto(b.area, 50) || 'General',
      descripcion: texto(b.descripcion, 500) || null,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      color,
      metrica
    }
  };
}

function validarConexion(bruto) {
  const b = bruto || {};
  const origenId = parseInt(b.origen_id, 10);
  const destinoId = parseInt(b.destino_id, 10);
  const tipo = texto(b.tipo, 20) || 'normal';

  if (!Number.isInteger(origenId) || origenId <= 0) return { ok: false, mensaje: 'El nodo de origen no es válido.' };
  if (!Number.isInteger(destinoId) || destinoId <= 0) return { ok: false, mensaje: 'El nodo de destino no es válido.' };
  if (origenId === destinoId) return { ok: false, mensaje: 'Un nodo no puede conectarse consigo mismo.' };
  if (!TIPOS_CONEXION.includes(tipo)) {
    return { ok: false, mensaje: `Tipo de conexión inválido: "${tipo}".` };
  }

  return { ok: true, datos: { origen_id: origenId, destino_id: destinoId, etiqueta: texto(b.etiqueta, 80) || null, tipo } };
}

/**
 * Envuelve un handler async y se come el error. Devuelve la promesa para que el
 * que llama pueda esperarla: si se omitiera, un await en los tests se
 * resolveria antes de que terminaran las consultas a la base.
 */
function asyncRuta(fn) {
  return (req, res) => {
    return fn(req, res).catch((err) => {
      console.error('Error en /api/flujo:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
      }
    });
  };
}

// ---------- LECTURA DEL GRAFO ----------

router.get('/', asyncRuta(async (req, res) => {
  const nodos = await db.query('SELECT * FROM flujo_nodos ORDER BY x ASC, y ASC, id ASC');
  const conexiones = await db.query('SELECT * FROM flujo_conexiones ORDER BY id ASC');

  res.json({
    success: true,
    nodos: nodos.rows,
    conexiones: conexiones.rows,
    metricas: METRICAS.map(({ clave, etiqueta }) => ({ clave, etiqueta })),
    areas: [...new Set(nodos.rows.map((n) => n.area))],
    tipos_conexion: TIPOS_CONEXION
  });
}));

/**
 * Las metricas en una sola ida a la base: cada conteo va como subconsulta
 * escalar de la consulta principal. Se escribe la sentencia a mano en vez de
 * recortar el sql del catalogo con una expresion regular: una subconsulta
 * escalar necesita los parentesis, y el recorte era fragil.
 */
const SQL_METRICAS = `SELECT
  (SELECT COUNT(*)::int FROM ordenes_compras_servicios WHERE tipo = 'OC' AND estado <> 'CANCELADA') AS m0,
  (SELECT COUNT(*)::int FROM ordenes_compras_servicios WHERE tipo = 'OS' AND estado <> 'CANCELADA') AS m1,
  (SELECT COUNT(*)::int FROM ordenes_compras_servicios WHERE estado IN ('RECIBIDA','COMPLETADA')) AS m2,
  (SELECT COUNT(*)::int FROM proveedores) AS m3,
  (SELECT COUNT(*)::int FROM ingresos_vigilancia WHERE estado = 'PENDIENTE CONFORMIDAD') AS m4,
  (SELECT COUNT(*)::int FROM registro_ingresos_almacen) AS m5,
  (SELECT COUNT(*)::int FROM inventario) AS m6,
  (SELECT COUNT(*)::int FROM inventario WHERE estado = 'REALIZAR PEDIDO') AS m7,
  (SELECT COUNT(*)::int FROM salidas_almacen) AS m8,
  (SELECT COUNT(*)::int FROM salidas_almacen WHERE estado_guia = 'PENDIENTE REGULARIZAR') AS m9,
  (SELECT COUNT(*)::int FROM historial_inventario) AS m10,
  (SELECT COUNT(*)::int FROM stock_proveedores) AS m11,
  (SELECT COUNT(*)::int FROM stock_proveedores_historial) AS m12,
  (SELECT COUNT(*)::int FROM reportes_soplado) AS m13,
  (SELECT COUNT(*)::int FROM reportes_produccion) AS m14,
  (SELECT COUNT(*)::int FROM reportes_refinado) AS m15,
  (SELECT COUNT(*)::int FROM stock_insumos_refinado) AS m16,
  (SELECT COUNT(*)::int FROM recetas WHERE activa) AS m17,
  (SELECT COUNT(*)::int FROM producto_terminado WHERE stock_cajas > 0) AS m18,
  (SELECT COUNT(*)::int FROM estado_lineas WHERE estado = 'EN MARCHA') AS m19`;

router.get('/metricas', asyncRuta(async (req, res) => {
  const r = await db.query(SQL_METRICAS);
  const fila = r.rows[0] || {};

  // El indice del array debe coincidir con el alias m0, m1, ... del SQL. Si se
  // añade una metrica hay que mover las dos cosas a la vez.
  const valores = {};
  METRICAS.forEach((m, i) => {
    valores[m.clave] = Number(fila[`m${i}`]) || 0;
  });

  res.json({ success: true, metricas: valores });
}));

// ---------- VERSIONES ----------

router.get('/versiones', asyncRuta(async (req, res) => {
  const r = await db.query(
    'SELECT id, nombre, usuario, fecha_creacion, jsonb_array_length(snapshot->\'nodos\') AS nodos, jsonb_array_length(snapshot->\'conexiones\') AS conexiones FROM flujo_versiones ORDER BY fecha_creacion DESC'
  );
  res.json({ success: true, versiones: r.rows });
}));

router.post('/versiones', asyncRuta(async (req, res) => {
  const nombre = texto(req.body && req.body.nombre, 120);
  const snapshot = (req.body && req.body.snapshot) || null;

  if (!nombre) return res.status(400).json({ success: false, mensaje: 'Ponle un nombre a la versión.' });
  if (!snapshot || !Array.isArray(snapshot.nodos) || !Array.isArray(snapshot.conexiones)) {
    return res.status(400).json({ success: false, mensaje: 'La versión debe incluir los nodos y las conexiones.' });
  }

  const r = await db.query(
    'INSERT INTO flujo_versiones (nombre, snapshot, usuario) VALUES ($1, $2::jsonb, $3) RETURNING *',
    [nombre, JSON.stringify(snapshot), req.usuario]
  );
  res.json({ success: true, version: r.rows[0] });
}));

router.post('/versiones/:id/restaurar', asyncRuta(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, mensaje: 'Versión no válida.' });
  }

  const v = await db.query('SELECT * FROM flujo_versiones WHERE id = $1', [id]);
  if (v.rows.length === 0) return res.status(404).json({ success: false, mensaje: 'La versión no existe.' });

  const snapshot = v.rows[0].snapshot || {};
  const nodos = Array.isArray(snapshot.nodos) ? snapshot.nodos : [];
  const conexiones = Array.isArray(snapshot.conexiones) ? snapshot.conexiones : [];

  if (nodos.length > MAX_NODOS) {
    return res.status(400).json({ success: false, mensaje: `La versión tiene más de ${MAX_NODOS} nodos.` });
  }

  // Se valida el snapshot completo antes de tocar la base. Validar nodo por
  // nodo mientras se escribía dejaba el grafo a medio camino si el último nódo
  // era inválido.
  const validados = [];
  const clavesVistas = new Set();
  for (const n of nodos) {
    const v2 = validarNodo(n);
    if (!v2.ok) return res.status(400).json({ success: false, mensaje: `Nodo inválido en la versión: ${v2.mensaje}` });
    if (clavesVistas.has(v2.datos.clave)) {
      return res.status(400).json({ success: false, mensaje: `Hay dos nodos con la clave "${v2.datos.clave}" en la versión.` });
    }
    clavesVistas.add(v2.datos.clave);
    validados.push(v2.datos);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config(\'app.current_user\', $1, true)', [req.usuario || 'sistema']);

    // Primero los nodos: las conexiones se resuelven por clave, porque al
    // reemplazar el grafo los id cambian y una arista solo apuntaria por id.
    // El mapa arranca vacío a propósito, para que una arista del snapshot no
    // pueda resolverse contra un nodo actual que se va a eliminar.
    const idPorClave = new Map();
    for (const d of validados) {
      const r = await client.query(
        `INSERT INTO flujo_nodos (clave, nombre, area, descripcion, x, y, color, metrica)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (clave) DO UPDATE SET
           nombre = EXCLUDED.nombre, area = EXCLUDED.area, descripcion = EXCLUDED.descripcion,
           x = EXCLUDED.x, y = EXCLUDED.y, color = EXCLUDED.color, metrica = EXCLUDED.metrica,
           fecha_actualizacion = NOW()
         RETURNING id, clave`,
        [d.clave, d.nombre, d.area, d.descripcion, d.x, d.y, d.color, d.metrica]
      );
      idPorClave.set(r.rows[0].clave, r.rows[0].id);
    }

    await client.query('DELETE FROM flujo_conexiones');
    // Restaurar significa volver a ese punto: los nodos que no estaban en el
    // snapshot desaparecen, igual que al guardar.
    await client.query('DELETE FROM flujo_nodos WHERE NOT (clave = ANY($1::text[]))', [[...clavesVistas]]);

    let creadas = 0;
    for (const c of conexiones) {
      const origen = idPorClave.get(texto(c.origen, 50));
      const destino = idPorClave.get(texto(c.destino, 50));
      if (!origen || !destino) continue;

      const v3 = validarConexion({ origen_id: origen, destino_id: destino, etiqueta: c.etiqueta, tipo: c.tipo });
      if (!v3.ok) continue;

      await client.query(
        `INSERT INTO flujo_conexiones (origen_id, destino_id, etiqueta, tipo) VALUES ($1, $2, $3, $4)
         ON CONFLICT (origen_id, destino_id) DO NOTHING`,
        [v3.datos.origen_id, v3.datos.destino_id, v3.datos.etiqueta, v3.datos.tipo]
      );
      creadas += 1;
    }

    await client.query('COMMIT');
    res.json({ success: true, mensaje: `Versión restaurada: ${validados.length} nodos y ${creadas} conexiones.`, restaurados: { nodos: validados.length, conexiones: creadas } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/versiones/:id', asyncRuta(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, mensaje: 'Versión no válida.' });
  }
  await db.query('DELETE FROM flujo_versiones WHERE id = $1', [id]);
  res.json({ success: true, mensaje: 'Versión eliminada.' });
}));

// ---------- NODOS ----------

router.post('/nodos', asyncRuta(async (req, res) => {
  const v = validarNodo(req.body);
  if (!v.ok) return res.status(400).json({ success: false, mensaje: v.mensaje });

  const total = await db.query('SELECT COUNT(*)::int n FROM flujo_nodos');
  if (total.rows[0].n >= MAX_NODOS) {
    return res.status(400).json({ success: false, mensaje: `El mapa no puede tener más de ${MAX_NODOS} nodos.` });
  }

  const r = await db.query(
    `INSERT INTO flujo_nodos (clave, nombre, area, descripcion, x, y, color, metrica)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [v.datos.clave, v.datos.nombre, v.datos.area, v.datos.descripcion, v.datos.x, v.datos.y, v.datos.color, v.datos.metrica]
  );
  res.json({ success: true, nodo: r.rows[0] });
}));

router.put('/nodos/:id', asyncRuta(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, mensaje: 'Nodo no válido.' });

  const v = validarNodo(req.body);
  if (!v.ok) return res.status(400).json({ success: false, mensaje: v.mensaje });

  const r = await db.query(
    `UPDATE flujo_nodos
     SET clave = $2, nombre = $3, area = $4, descripcion = $5, x = $6, y = $7, color = $8, metrica = $9, fecha_actualizacion = NOW()
     WHERE id = $1 RETURNING *`,
    [id, v.datos.clave, v.datos.nombre, v.datos.area, v.datos.descripcion, v.datos.x, v.datos.y, v.datos.color, v.datos.metrica]
  );
  if (r.rows.length === 0) return res.status(404).json({ success: false, mensaje: 'El nodo no existe.' });
  res.json({ success: true, nodo: r.rows[0] });
}));

router.delete('/nodos/:id', asyncRuta(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, mensaje: 'Nodo no válido.' });

  // Las conexiones se van solas por ON DELETE CASCADE.
  await db.query('DELETE FROM flujo_nodos WHERE id = $1', [id]);
  res.json({ success: true, mensaje: 'Nodo eliminado.' });
}));

// ---------- CONEXIONES ----------

router.post('/conexiones', asyncRuta(async (req, res) => {
  const v = validarConexion(req.body);
  if (!v.ok) return res.status(400).json({ success: false, mensaje: v.mensaje });

  const nodos = await db.query('SELECT id FROM flujo_nodos WHERE id = ANY($1::int[])', [[v.datos.origen_id, v.datos.destino_id]]);
  if (nodos.rows.length !== 2) {
    return res.status(400).json({ success: false, mensaje: 'Alguno de los nodos de la conexión no existe.' });
  }

  const r = await db.query(
    `INSERT INTO flujo_conexiones (origen_id, destino_id, etiqueta, tipo) VALUES ($1, $2, $3, $4)
     ON CONFLICT (origen_id, destino_id) DO UPDATE SET etiqueta = EXCLUDED.etiqueta, tipo = EXCLUDED.tipo, fecha_actualizacion = NOW()
     RETURNING *`,
    [v.datos.origen_id, v.datos.destino_id, v.datos.etiqueta, v.datos.tipo]
  );
  res.json({ success: true, conexion: r.rows[0] });
}));

router.delete('/conexiones/:id', asyncRuta(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, mensaje: 'Conexión no válida.' });

  await db.query('DELETE FROM flujo_conexiones WHERE id = $1', [id]);
  res.json({ success: true, mensaje: 'Conexión eliminada.' });
}));

/**
 * Guardado masivo: reemplaza el grafo entero en una transaccion.
 *
 * Es la via que usa el autoguardado del cliente. Va en transaccion a proposito:
 * si fallara a la mitad, el mapa de la base no quedaria con la mitad de los
 * nodos nuevos. Las conexiones se borran y se reinsertan porque sus id cambian
 * al recargar; las claves de los nodos si se conservan, asi que el autoguardado
 * no invalida referencias externas por id.
 */
router.put('/', asyncRuta(async (req, res) => {
  const nodosRaw = (req.body && req.body.nodos) || [];
  const conexionesRaw = (req.body && req.body.conexiones) || [];

  if (!Array.isArray(nodosRaw) || !Array.isArray(conexionesRaw)) {
    return res.status(400).json({ success: false, mensaje: 'Se esperaban los arrays nodos y conexiones.' });
  }
  if (nodosRaw.length > MAX_NODOS) {
    return res.status(400).json({ success: false, mensaje: `El mapa no puede tener más de ${MAX_NODOS} nodos.` });
  }

  const validados = [];
  const clavesVistas = new Set();

  for (const n of nodosRaw) {
    const v = validarNodo(n);
    if (!v.ok) return res.status(400).json({ success: false, mensaje: v.mensaje });
    if (clavesVistas.has(v.datos.clave)) {
      return res.status(400).json({ success: false, mensaje: `Hay dos nodos con la clave "${v.datos.clave}".` });
    }
    clavesVistas.add(v.datos.clave);
    validados.push(v.datos);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // set_config para que cualquier trigger de auditoría sepa quién guardó.
    await client.query('SELECT set_config(\'app.current_user\', $1, true)', [req.usuario || 'sistema']);

    const idPorClave = new Map();
    for (const d of validados) {
      const r = await client.query(
        `INSERT INTO flujo_nodos (clave, nombre, area, descripcion, x, y, color, metrica)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (clave) DO UPDATE SET
           nombre = EXCLUDED.nombre, area = EXCLUDED.area, descripcion = EXCLUDED.descripcion,
           x = EXCLUDED.x, y = EXCLUDED.y, color = EXCLUDED.color, metrica = EXCLUDED.metrica,
           fecha_actualizacion = NOW()
         RETURNING id, clave`,
        [d.clave, d.nombre, d.area, d.descripcion, d.x, d.y, d.color, d.metrica]
      );
      idPorClave.set(r.rows[0].clave, r.rows[0].id);
    }

    // Los nodos que el cliente ya no envia se van del mapa. El guardado masivo
    // reemplaza el grafo completo, no solo lo que aparece en pantalla: sin
    // este DELETE, un nodo borrado en la UI volveria en la siguiente carga.
    // Con el array vacio borra todo, que es lo correcto para un mapa sin nodos.
    await client.query('DELETE FROM flujo_nodos WHERE NOT (clave = ANY($1::text[]))', [[...clavesVistas]]);
    await client.query('DELETE FROM flujo_conexiones');

    let creadas = 0;
    for (const c of conexionesRaw) {
      const origenId = idPorClave.get(texto(c.origen, 50));
      const destinoId = idPorClave.get(texto(c.destino, 50));
      if (!origenId || !destinoId) continue;

      const v = validarConexion({ origen_id: origenId, destino_id: destinoId, etiqueta: c.etiqueta, tipo: c.tipo });
      if (!v.ok) continue;

      await client.query(
        `INSERT INTO flujo_conexiones (origen_id, destino_id, etiqueta, tipo) VALUES ($1, $2, $3, $4)
         ON CONFLICT (origen_id, destino_id) DO UPDATE SET etiqueta = EXCLUDED.etiqueta, tipo = EXCLUDED.tipo, fecha_actualizacion = NOW()`,
        [v.datos.origen_id, v.datos.destino_id, v.datos.etiqueta, v.datos.tipo]
      );
      creadas += 1;
    }

    await client.query('COMMIT');
    res.json({ success: true, mensaje: 'Mapa guardado.', nodos: validados.length, conexiones: creadas });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
