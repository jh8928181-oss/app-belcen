// .env.local se carga al final y con override: si existe, sus valores ganan sobre
// .env. Permite apuntar a otra base en local (p. ej. Supabase) sin editar el .env
// compartido, que sigue documentando la base vieja de Render.
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });

const express = require('express');
const pool = require('./db');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const os = require('os');
const tesseract = require('tesseract.js');
const { analizarDocumentoConGemini } = require('./services/geminiService');
const { initRedis } = require('./services/rateLimiter');
const { authMiddleware, crearGuardRoles, ROLES_MODULO } = require('./middleware/auth');
const { calcularInsumosProduccion } = require('./services/recipeService');
const { datosParaOrdenPDF, datosFormularioOC } = require('./services/ocPdfDatos');
const { generarPDFOrdenCompra, nombreArchivoSeguro } = require('./services/pdfOrdenCompra');
const { normalizar } = require('./utils/helpers');

process.on('unhandledRejection', (reason) => {
    console.error('Rechazo no manejado:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'public/uploads/' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        }
    }
}));

// Mapeo oficial de keys y nombres legibles
const PRODUCTOS_TERMINADOS_MAP = {
    'b1_200ml': 'Aceite de Soya B-1 200 ml',
    'b1_500ml': 'Aceite de Soya B-1 500 ml',
    'b1_900ml': 'Aceite de Soya B-1 900 ml',
    'b1_1lt': 'Aceite de Soya B-1 1 Lt',
    'b1_2lt': 'Aceite de Soya B-1 2 Lt',
    'b1_5lt': 'Aceite de Soya B-1 5 Lt (Galonera)',
    'donlalo_800ml': 'Aceite de Soya Don Lalo 800 ml',
    'donlalo_20lt': 'Aceite de Soya Don Lalo Balde 20 Lt',
    'belini_200ml': 'Aceite de Soya Belini 200 ml',
    'belini_500ml': 'Aceite de Soya Belini 500 ml',
    'belini_900ml': 'Aceite de Soya Belini 900 ml',
    'belini_1lt': 'Aceite de Soya Belini 1 Lt',
    'belini_2lt': 'Aceite de Soya Belini 2 Lt (Galonera)',
    'belini_3lt': 'Aceite de Soya Belini 3 Lt',
    'belini_5lt': 'Aceite de Soya Belini 5 Lt (Galonera)',
    'belini_lata18lt': 'Aceite de Soya Belini Lata 18 Lt',
    'belini_balde18lt': 'Aceite de Soya Belini Balde 18 Lt'
};

// --- RUTAS MODULARES ---
const routes = require('./routes');
app.use(routes);

// --- AUTH GLOBAL para el resto de endpoints /api (protege todo salvo /api/login) ---
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  authMiddleware(req, res, next);
});

// --- GUARDS DE ROL ---
// Los guards marcados con { enforce: true } ya existían antes y siempre bloquearon.
// Los nuevos nacen en MODO OBSERVACIÓN: registran en consola en vez de rechazar.
// Actívalos con ENFORCE_ROLES=true en el entorno cuando hayas revisado el log.
const gVigilancia    = crearGuardRoles(ROLES_MODULO.vigilancia, { mensaje: 'Solo vigilancia, supervisor o administrador pueden registrar ingresos.' });
const gAlmacen       = crearGuardRoles(ROLES_MODULO.almacen,    { mensaje: 'Solo almacén, supervisor o administrador pueden modificar el almacén.' });
const gSoplado       = crearGuardRoles(ROLES_MODULO.soplado,    { mensaje: 'Solo soplado, supervisor o administrador pueden registrar soplado.' });
const gEnvasado      = crearGuardRoles(ROLES_MODULO.envasado,   { mensaje: 'Solo envasado, producción, supervisor o administrador pueden modificar la línea.' });
const gProduccion    = crearGuardRoles(ROLES_MODULO.produccion, { mensaje: 'Solo producción, supervisor o administrador pueden modificar producción.' });
const gAuditoria     = crearGuardRoles(ROLES_MODULO.auditoria,  { mensaje: 'Solo auditoría, producción, supervisor o administrador pueden ver la auditoría.' });
const gIA            = crearGuardRoles(ROLES_MODULO.ia,         { mensaje: 'No tienes acceso al lector de documentos.' });

// --- VIGILANCIA (SOPORTE MÚLTIPLE DE PRODUCTOS Y DATOS DE TRANSPORTE) ---
app.post('/api/vigilancia/registrar', gVigilancia, upload.single('foto_guia'), async (req, res) => {
    try {
        const { 
            tipo_documento, 
            numero_guia, 
            proveedor, 
            chofer, 
            dni_chofer, 
            placa, 
            lugar_partida, 
            punto_llegada, 
            observaciones, 
            usuario, 
            items_json 
        } = req.body;
        
        const foto_url = req.file ? `/uploads/${req.file.filename}` : null;
        const items = JSON.parse(items_json || '[]');

        const query = `
            INSERT INTO ingresos_vigilancia 
            (tipo_documento, numero_guia, proveedor, chofer, dni_chofer, placa, lugar_partida, punto_llegada, observaciones, foto_url, usuario_vigilancia, items_json, estado, fecha_ingreso)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDIENTE CONFORMIDAD', NOW()) 
            RETURNING *;
        `;
        
        const values = [
            tipo_documento, 
            numero_guia, 
            proveedor, 
            chofer || '', 
            dni_chofer || '', 
            placa || '', 
            lugar_partida || '', 
            punto_llegada || 'Planta Principal - Corporación Belcen', 
            observaciones || '', 
            foto_url, 
            usuario || 'vigilancia1', 
            JSON.stringify(items)
        ];
        
        const nuevoIngreso = await pool.query(query, values);
        res.json({ success: true, mensaje: 'Ingreso registrado con múltiples productos y datos de transporte correctamente.', ingreso: nuevoIngreso.rows[0] });
    } catch (err) {
        console.error("Error en vigilancia:", err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar en vigilancia: ' + err.message });
    }
});

// --- ALMACÉN: PENDIENTES Y CONFORMIDAD ---
app.get('/api/almacen/pendientes', gAlmacen, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM ingresos_vigilancia WHERE estado = 'PENDIENTE CONFORMIDAD' ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener pendientes:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener pendientes: ' + err.message });
    }
});

app.post('/api/almacen/conformidad', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const { ingreso_id, usuario_almacen, items_ajustados } = req.body;
        await client.query('BEGIN');

        const ingresoRes = await client.query('SELECT * FROM ingresos_vigilancia WHERE id = $1', [ingreso_id]);
        if (ingresoRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El ingreso no existe.' });
        }
        const ingreso = ingresoRes.rows[0];
        const items = JSON.parse(ingreso.items_json || '[]');

        // Ajustes manuales opcionales (integración manual de ítems que no existen en el inventario).
        const ajustes = new Map();
        if (Array.isArray(items_ajustados)) {
            items_ajustados.forEach(a => {
                if (a && a.nombre) ajustes.set(String(a.nombre).trim().toLowerCase(), a);
            });
        }

        let tieneDiferencias = false;

        for (const item of items) {
            const ajuste = ajustes.get((item.nombre || '').trim().toLowerCase());
            const nombreFinal = (ajuste && ajuste.nombre_ajustado && ajuste.nombre_ajustado.trim()) ? ajuste.nombre_ajustado.trim() : item.nombre;
            const categoriaFinal = (ajuste && ajuste.categoria) ? ajuste.categoria : 'General';
            const unidadFinal = (ajuste && ajuste.unidad_medida) ? ajuste.unidad_medida : 'UNIDADES';
            const cantidadFisica = ajuste && ajuste.cantidad_fisica !== undefined && ajuste.cantidad_fisica !== '' ? Number(ajuste.cantidad_fisica) : Number(item.cantidad_fisica) || 0;

            let estadoItem = 'CON GUIA';
            if (Number(item.cantidad_guia) !== Number(cantidadFisica)) {
                tieneDiferencias = true;
                estadoItem = 'POR REGULARIZAR';
            }

            let targetArticuloId = null;
            const existeRes = await client.query('SELECT id, stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [nombreFinal]);
            
            if (existeRes.rows.length > 0) {
                targetArticuloId = existeRes.rows[0].id;
                const stockAnterior = Number(existeRes.rows[0].stock) || 0;
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidadFisica, targetArticuloId]);
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad',
                    producto: nombreFinal, articulo_id: targetArticuloId,
                    cantidad: cantidadFisica, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidadFisica,
                    usuario: usuarioResponsable(req, usuario_almacen),
                    referencia: 'Conformidad - guía ' + (ingreso.numero_guia || 'S/N')
                });
            } else {
                const nuevoArt = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) VALUES ($1, $2, $3, $4, 'STOCK SUFICIENTE') RETURNING id`,
                    [nombreFinal, categoriaFinal || 'General', cantidadFisica, unidadFinal || 'UNIDADES']
                );
                targetArticuloId = nuevoArt.rows[0].id;
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad',
                    producto: nombreFinal, articulo_id: targetArticuloId,
                    cantidad: cantidadFisica, tipo_cambio: 'SUMA',
                    stock_anterior: 0, stock_nuevo: cantidadFisica,
                    usuario: usuarioResponsable(req, usuario_almacen),
                    referencia: 'Conformidad (artículo nuevo - integración manual) - guía ' + (ingreso.numero_guia || 'S/N')
                });
            }
            await actualizarEstadoArticulo(client, nombreFinal);

            await client.query(`
                INSERT INTO registro_ingresos_almacen (fecha_registro, numero_guia, proveedor, producto_nombre, cantidad, estado, articulo_id)
                VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6);
            `, [ingreso.numero_guia, ingreso.proveedor, nombreFinal, cantidadFisica, estadoItem, targetArticuloId]);
        }

        // BASE DE DATOS GENERAL: disminuye el stock de proveedores por la cantidad que llegó en la guía.
        try {
            await aplicarGuiaAStockProveedores(client, ingreso.proveedor, items, ingreso.numero_guia, usuarioResponsable(req, usuario_almacen));
        } catch (eAuto) {
            console.error('Guía -> stock proveedores (conformidad):', eAuto.message);
        }

        const estadoFinalIngreso = tieneDiferencias ? 'CONFORME CON DIFERENCIAS (POR REGULARIZAR)' : `RECIBIDO POR ${usuario_almacen}`;
        await client.query(`UPDATE ingresos_vigilancia SET estado = $1 WHERE id = $2`, [estadoFinalIngreso, ingreso_id]);

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Conformidad procesada y stock actualizado correctamente.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error en conformidad:", err);
        res.status(500).json({ success: false, mensaje: 'Error al procesar conformidad: ' + err.message });
    } finally {
        client.release();
    }
});

// --- ALMACÉN: REGISTRO DIRECTO DE INGRESO CONFORME (con IA / guía) ---
app.post('/api/almacen/registrar-conforme', gAlmacen, upload.single('foto_guia'), async (req, res) => {
    const client = await pool.connect();
    try {
        const {
            tipo_documento,
            numero_guia,
            proveedor,
            chofer,
            dni_chofer,
            placa,
            lugar_partida,
            punto_llegada,
            observaciones,
            usuario,
            items_json
        } = req.body;

        await client.query('BEGIN');

        const items = JSON.parse(items_json || '[]');
        if (!Array.isArray(items) || items.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Debe incluir al menos un producto en el ingreso.' });
        }

        const foto_url = req.file ? `/uploads/${req.file.filename}` : null;
        const usuarioRegistro = usuario || 'almacen1';

        let tieneDiferencias = false;
        for (const item of items) {
            if (Number(item.cantidad_guia) !== Number(item.cantidad_fisica)) {
                tieneDiferencias = true;
                break;
            }
        }

        const estadoFinal = tieneDiferencias
            ? 'CONFORME CON DIFERENCIAS (POR REGULARIZAR)'
            : `RECIBIDO POR ${usuarioRegistro}`;

        const insert = await client.query(
            `INSERT INTO ingresos_vigilancia
             (tipo_documento, numero_guia, proveedor, chofer, dni_chofer, placa, lugar_partida, punto_llegada, observaciones, foto_url, usuario_vigilancia, items_json, estado, fecha_ingreso)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
             RETURNING id, numero_guia`,
            [
                tipo_documento, numero_guia, proveedor,
                chofer || '', dni_chofer || '', placa || '',
                lugar_partida || '', punto_llegada || 'Planta Principal - Corporación Belcen',
                observaciones || '', foto_url, usuarioRegistro, JSON.stringify(items), estadoFinal
            ]
        );
        const ingresoId = insert.rows[0].id;

        for (const item of items) {
            let estadoItem = 'CON GUIA';
            if (Number(item.cantidad_guia) !== Number(item.cantidad_fisica)) {
                estadoItem = 'POR REGULARIZAR';
            }

            const cantidadFisica = Number(item.cantidad_fisica) || 0;
            const existeRes = await client.query('SELECT id, stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [item.nombre]);
            let targetArticuloId;
            if (existeRes.rows.length > 0) {
                targetArticuloId = existeRes.rows[0].id;
                const stockAnterior = Number(existeRes.rows[0].stock) || 0;
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidadFisica, targetArticuloId]);
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad',
                    producto: item.nombre, articulo_id: targetArticuloId,
                    cantidad: cantidadFisica, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidadFisica,
                    usuario: usuarioResponsable(req, usuarioRegistro),
                    referencia: 'Conformidad - guía ' + (numero_guia || 'S/N')
                });
            } else {
                const nuevoArt = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) VALUES ($1, 'General', $2, 'UNIDADES', 'STOCK SUFICIENTE') RETURNING id`,
                    [item.nombre, cantidadFisica]
                );
                targetArticuloId = nuevoArt.rows[0].id;
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad',
                    producto: item.nombre, articulo_id: targetArticuloId,
                    cantidad: cantidadFisica, tipo_cambio: 'SUMA',
                    stock_anterior: 0, stock_nuevo: cantidadFisica,
                    usuario: usuarioResponsable(req, usuarioRegistro),
                    referencia: 'Conformidad (artículo nuevo) - guía ' + (numero_guia || 'S/N')
                });
            }
            await actualizarEstadoArticulo(client, item.nombre);

            await client.query(
                `INSERT INTO registro_ingresos_almacen (fecha_registro, numero_guia, proveedor, producto_nombre, cantidad, estado, articulo_id)
                 VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6)`,
                [numero_guia, proveedor, item.nombre, item.cantidad_fisica, estadoItem, targetArticuloId]
            );
        }

        // BASE DE DATOS GENERAL: disminuye el stock de proveedores por la cantidad que llegó en la guía.
        try {
            await aplicarGuiaAStockProveedores(client, proveedor, items, numero_guia, usuarioRegistro);
        } catch (eAuto) {
            console.error('Guía -> stock proveedores (registrar-conforme):', eAuto.message);
        }

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Ingreso registrado conforme. Stock actualizado.', ingreso: { id: ingresoId, numero_guia } });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en registrar-conforme:', err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar el ingreso conforme: ' + err.message });
    } finally {
        client.release();
    }
});

app.get('/api/almacen/registro-ingresos', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM registro_ingresos_almacen ORDER BY id DESC LIMIT 100`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/almacen/conformidad-ajustada', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const { ingreso_id, usuario_almacen, items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, mensaje: 'Debe especificar al menos un producto para ajustar.' });
        }
        await client.query('BEGIN');

        const ingresoRes = await client.query('SELECT * FROM ingresos_vigilancia WHERE id = $1', [ingreso_id]);
        if (ingresoRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El ingreso no existe.' });
        }
        const ingreso = ingresoRes.rows[0];

        let tieneDiferencias = false;

        for (const item of items) {
            const nombre = (item.nombre || '').trim();
            const cantidad = parseFloat(item.cantidad);
            if (!nombre || isNaN(cantidad) || cantidad < 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `Producto inválido: "${item.nombre || ''}" con cantidad ${item.cantidad}.` });
            }
            const categoria = (item.categoria || 'General').trim();
            const unidad_medida = (item.unidad_medida || 'UNIDADES').trim();
            const cantidadGuiaRaw = item.cantidad_guia;
            const cantidadGuia = cantidadGuiaRaw === undefined || cantidadGuiaRaw === null || cantidadGuiaRaw === ''
                ? cantidad
                : parseFloat(cantidadGuiaRaw);
            let estadoItem = 'CON GUIA';
            if (isNaN(cantidadGuia) || Math.abs(cantidad - cantidadGuia) > 0.0001) {
                tieneDiferencias = true;
                estadoItem = 'POR REGULARIZAR';
            }

            const existeRes = await client.query('SELECT id, stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [nombre]);
            let targetArticuloId;
            if (existeRes.rows.length > 0) {
                targetArticuloId = existeRes.rows[0].id;
                const stockAnterior = Number(existeRes.rows[0].stock) || 0;
                await client.query(
                    `UPDATE inventario SET stock = stock + $1 WHERE id = $2`,
                    [cantidad, targetArticuloId]
                );
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad_ajustada',
                    producto: nombre, articulo_id: targetArticuloId,
                    cantidad, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidad,
                    usuario: usuarioResponsable(req, usuario_almacen),
                    referencia: 'Conformidad ajustada - guía ' + (ingreso.numero_guia || 'S/N')
                });
            } else {
                const nuevoArt = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado)
                     VALUES ($1, $2, $3, $4, CASE WHEN $3 <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END)
                     RETURNING id`,
                    [nombre, categoria, cantidad, unidad_medida]
                );
                targetArticuloId = nuevoArt.rows[0].id;
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad_ajustada',
                    producto: nombre, articulo_id: targetArticuloId,
                    cantidad, tipo_cambio: 'SUMA',
                    stock_anterior: 0, stock_nuevo: cantidad,
                    usuario: usuarioResponsable(req, usuario_almacen),
                    referencia: 'Conformidad ajustada (artículo nuevo) - guía ' + (ingreso.numero_guia || 'S/N')
                });
            }
            await actualizarEstadoArticulo(client, nombre);

            await client.query(`
                INSERT INTO registro_ingresos_almacen (fecha_registro, numero_guia, proveedor, producto_nombre, cantidad, estado, articulo_id, categoria, unidad_medida)
                VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8);
            `, [ingreso.numero_guia, ingreso.proveedor, nombre, cantidad, estadoItem, targetArticuloId, categoria, unidad_medida]);
        }

        const estadoFinalIngreso = tieneDiferencias ? 'CONFORME CON DIFERENCIAS (POR REGULARIZAR)' : `RECIBIDO POR ${usuario_almacen || 'almacen1'}`;
        await client.query(`UPDATE ingresos_vigilancia SET estado = $1 WHERE id = $2`, [estadoFinalIngreso, ingreso_id]);

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Ingreso ajustado y stock actualizado correctamente.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error en conformidad ajustada:", err);
        res.status(500).json({ success: false, mensaje: 'Error al procesar la conformidad ajustada: ' + err.message });
    } finally {
        client.release();
    }
});

// --- ALMACÉN: ANULAR PENDIENTE DE VIGILANCIA (marca ANULADO, no toca stock) ---
app.post('/api/almacen/pendientes/anular', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const { ingreso_id, usuario_almacen, observacion } = req.body;
        if (!ingreso_id) {
            return res.status(400).json({ success: false, mensaje: 'Falta el identificador del ingreso.' });
        }
        await client.query('BEGIN');

        const upd = await client.query(
            `UPDATE ingresos_vigilancia
             SET estado = 'ANULADO',
                 fecha_anulacion = CURRENT_TIMESTAMP,
                 anulado_por = $2,
                 observacion_anulacion = $3
             WHERE id = $1 AND estado = 'PENDIENTE CONFORMIDAD'
             RETURNING id, numero_guia, proveedor`,
            [ingreso_id, usuarioResponsable(req, usuario_almacen), observacion || null]
        );
        if (upd.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'No se pudo anular: el pendiente no existe o ya fue procesado.' });
        }

        const pend = upd.rows[0];
        await registrarHistorial(client, {
            tipo: 'ANULACION', origen: 'almacen_anulacion',
            producto: pend.proveedor || 'N/D', articulo_id: null,
            cantidad: 0, tipo_cambio: 'SUMA',
            stock_anterior: null, stock_nuevo: null,
            usuario: usuarioResponsable(req, usuario_almacen),
            referencia: 'Anulación ingreso #' + pend.id + ' - guía ' + (pend.numero_guia || 'S/N') + (observacion ? ' | ' + observacion : '')
        });

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Pendiente anulado correctamente (sin cambios de stock).' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error al anular pendiente:", err);
        res.status(500).json({ success: false, mensaje: 'Error al anular el pendiente: ' + err.message });
    } finally {
        client.release();
    }
});

// --- ALMACÉN: CREAR NUEVO PRODUCTO EN INVENTARIO ---
app.post('/api/inventario/nuevo', gAlmacen, async (req, res) => {
    try {
        const { nombre, categoria, unidad_medida, stock } = req.body;
        const nom = (nombre || '').trim();
        if (!nom) {
            return res.status(400).json({ success: false, mensaje: 'El nombre del producto es obligatorio.' });
        }
        const cat = (categoria || 'General').trim();
        const uni = (unidad_medida || 'UNIDADES').trim();
        const stockInicial = parseFloat(stock);
        const stockValido = isNaN(stockInicial) || stockInicial < 0 ? 0 : stockInicial;

        const existe = await pool.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [nom]);
        if (existe.rows.length > 0) {
            return res.status(400).json({ success: false, mensaje: `Ya existe "${nom}" en el inventario. Usa el botón Ajustar para corregir su stock.` });
        }

        const nuevo = await pool.query(
            `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado)
             VALUES ($1, $2, $3, $4, CASE WHEN $3 <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END)
             RETURNING id, nombre`,
            [nom, cat, stockValido, uni]
        );
        res.json({ success: true, mensaje: 'Producto registrado en el inventario.', articulo_id: nuevo.rows[0].id });
    } catch (err) {
        console.error("Error al crear producto:", err);
        res.status(500).json({ success: false, mensaje: 'Error al crear producto: ' + err.message });
    }
});

// --- ALMACÉN: AJUSTE MANUAL DE INVENTARIO INSUMOS ---
// El ajuste y su registro de historial van en la MISMA transaccion: si no queda
// anotado, el stock se revierte. Un ajuste sin rastro no se puede reconstruir.
app.post('/api/almacen/ajustar-stock', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const { articulo_id, nuevo_stock } = req.body;
        const cantidadNueva = Number(nuevo_stock);
        if (isNaN(cantidadNueva)) {
            return res.status(400).json({ success: false, mensaje: 'El nuevo stock debe ser un número válido.' });
        }

        await client.query('BEGIN');
        const actual = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [articulo_id]);
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El artículo no existe.' });
        }
        const nombreArticulo = actual.rows[0].nombre;
        const stockAnterior = Number(actual.rows[0].stock) || 0;

        const upd = await client.query(
            `UPDATE inventario
             SET stock = $1::numeric,
                 estado = CASE WHEN $1::numeric <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END
             WHERE id = $2`,
            [cantidadNueva, articulo_id]
        );
        if (upd.rowCount !== 1) {
            throw new Error(`No se pudo ajustar el stock de "${nombreArticulo}".`);
        }

        const diferencia = cantidadNueva - stockAnterior;
        await registrarHistorial(client, {
            tipo: 'AJUSTE',
            origen: 'almacen',
            producto: nombreArticulo,
            articulo_id: articulo_id,
            cantidad: Math.abs(diferencia),
            tipo_cambio: diferencia >= 0 ? 'SUMA' : 'RESTA',
            stock_anterior: stockAnterior,
            stock_nuevo: cantidadNueva,
            usuario: usuarioResponsable(req, req.body.usuario),
            referencia: 'Ajuste manual de stock'
        });

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Stock de insumo ajustado manualmente.' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("Error al ajustar stock:", err);
        res.status(500).json({ success: false, mensaje: 'Error al actualizar el stock manualmente: ' + err.message });
    } finally {
        client.release();
    }
});

// --- PRODUCTO TERMINADO: CONSULTA Y AJUSTE ---
app.get('/api/producto-terminado', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *, 
                   CASE 
                       WHEN stock_minimo > 0 AND stock_cajas <= stock_minimo THEN 'REALIZAR PEDIDO'
                       WHEN stock_cajas <= 0 THEN 'REALIZAR PEDIDO'
                       ELSE 'STOCK SUFICIENTE'
                   END AS estado
            FROM producto_terminado 
            ORDER BY nombre_producto ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener productos terminados:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener productos terminados' });
    }
});

// Ajuste y auditoría en la misma transacción: si no queda registrado, se revierte.
app.post('/api/producto-terminado/ajustar', gEnvasado, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id, nuevo_stock } = req.body;
        const cantidadNueva = Number(nuevo_stock);
        if (isNaN(cantidadNueva)) {
            return res.status(400).json({ success: false, mensaje: 'El nuevo stock debe ser un número válido.' });
        }
        await client.query('BEGIN');
        const actual = await client.query('SELECT producto_key, nombre_producto, stock_cajas FROM producto_terminado WHERE id = $1', [id]);
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El producto terminado no existe.' });
        }
        const stockAnterior = Number(actual.rows[0].stock_cajas) || 0;
        await client.query('UPDATE producto_terminado SET stock_cajas = $1 WHERE id = $2', [cantidadNueva, id]);
        const diferencia = cantidadNueva - stockAnterior;
        await registrarHistorial(client, {
            tipo: 'AJUSTE',
            origen: 'producto_terminado',
            producto: actual.rows[0].nombre_producto,
            producto_key: actual.rows[0].producto_key,
            cantidad: Math.abs(diferencia),
            tipo_cambio: diferencia >= 0 ? 'SUMA' : 'RESTA',
            stock_anterior: stockAnterior,
            stock_nuevo: cantidadNueva,
            usuario: usuarioResponsable(req, req.body.usuario),
            referencia: 'Ajuste manual de producto terminado'
        });
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Stock de producto terminado actualizado correctamente.' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("Error al ajustar producto terminado:", err);
        res.status(500).json({ success: false, mensaje: 'Error al ajustar stock de producto terminado' });
    } finally {
        client.release();
    }
});

app.post('/api/producto-terminado/minimo', async (req, res) => {
    try {
        const { id, stock_minimo } = req.body;
        if (!id || isNaN(parseInt(stock_minimo))) {
            return res.status(400).json({ success: false, mensaje: 'Producto y stock mínimo válido son requeridos.' });
        }
        await pool.query('UPDATE producto_terminado SET stock_minimo = $1 WHERE id = $2', [parseInt(stock_minimo), id]);
        res.json({ success: true, mensaje: 'Stock mínimo del producto actualizado.' });
    } catch (err) {
        console.error("Error al actualizar stock mínimo:", err);
        res.status(500).json({ success: false, mensaje: 'Error al actualizar el stock mínimo: ' + err.message });
    }
});

// Alta manual de producto terminado SIN descontar insumos (por ejemplo, lotes ya producidos que ingresan a almacén)
app.post('/api/producto-terminado/agregar-manual', gEnvasado, async (req, res) => {
    const client = await pool.connect();
    try {
        const { producto_tipo, cantidad } = req.body;
        const cajas = parseInt(cantidad);
        if (!producto_tipo || !cajas || cajas <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Producto y cantidad válida son requeridos.' });
        }
        const nombreLegible = PRODUCTOS_TERMINADOS_MAP[producto_tipo] || producto_tipo;
        await client.query('BEGIN');
        const previo = await client.query('SELECT stock_cajas FROM producto_terminado WHERE producto_key = $1', [producto_tipo]);
        const stockAnterior = previo.rows.length > 0 ? Number(previo.rows[0].stock_cajas) || 0 : 0;
        await client.query(`
            INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas)
            VALUES ($1, $2, $3)
            ON CONFLICT (producto_key)
            DO UPDATE SET stock_cajas = producto_terminado.stock_cajas + EXCLUDED.stock_cajas;
        `, [producto_tipo, nombreLegible, cajas]);
        await registrarHistorial(client, {
            tipo: 'ENTRADA',
            origen: 'producto_terminado',
            producto: nombreLegible,
            producto_key: producto_tipo,
            cantidad: cajas,
            tipo_cambio: 'SUMA',
            stock_anterior: stockAnterior,
            stock_nuevo: stockAnterior + cajas,
            usuario: usuarioResponsable(req, req.body.usuario),
            referencia: 'Alta manual de producto terminado (sin descontar insumos)'
        });
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Producto terminado agregado manualmente sin descontar insumos.' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("Error al agregar producto terminado manual:", err);
        res.status(500).json({ success: false, mensaje: 'Error al agregar producto terminado: ' + err.message });
    } finally {
        client.release();
    }
});

// --- INVENTARIO GENERAL ---
app.get('/api/inventario', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, nombre, categoria, stock, 
                   COALESCE(unidad_medida, 'UNIDADES') as unidad_medida, 
                   COALESCE(estado, 'STOCK SUFICIENTE') as estado 
            FROM inventario 
            ORDER BY id ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener inventario:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener el inventario: ' + err.message });
    }
});

// --- SOPLADO (CON PREFORMA SELECCIONADA Y ETIQUETA AUTOMÁTICA) ---
app.post('/api/soplado/registrar', gSoplado, async (req, res) => {
    const client = await pool.connect();
    try {
        const { preforma_nombre, botella_tipo, cantidad_producida, usuario } = req.body;
        const cantidadBotellas = parseInt(cantidad_producida, 10);
        if (!cantidadBotellas || cantidadBotellas <= 0 || cantidadBotellas > 1000000) {
            return res.status(400).json({ success: false, mensaje: 'Cantidad producida inválida. Debe ser un número entero mayor a 0.' });
        }
        if (!preforma_nombre || !String(preforma_nombre).trim()) {
            return res.status(400).json({ success: false, mensaje: 'Debe seleccionar cuál preforma se usó.' });
        }

        await client.query('BEGIN');

        let etiquetaNombre = null;
        let botellaNombre = '';

        switch (botella_tipo) {
            // LÍNEA BELINI
            case 'soplado_belini_200ml':
                botellaNombre = 'Botella Belini x 200 ml';
                etiquetaNombre = 'Etiqueta couche 90 gr x 200 ml B-1';
                break;
            case 'soplado_belini_500ml':
                botellaNombre = 'Botella Belini x 500 ml';
                etiquetaNombre = 'Etiqueta couche 90 gr x 500 ml Belini';
                break;
            case 'soplado_belini_900ml':
                botellaNombre = 'Botella Belini x 900 ml';
                etiquetaNombre = 'Etiqueta couche 90 gr x 900 ml Belini';
                break;
            case 'soplado_belini_1lt':
                botellaNombre = 'Botella Belini x 1 Lt';
                etiquetaNombre = 'Etiqueta couche 90 gr x 1 lt Belini';
                break;
            case 'soplado_belini_3lt':
                botellaNombre = 'Botella Belini x 3 lt';
                etiquetaNombre = 'Etiqueta polipropileno blanco x 3 lt Belini';
                break;

            // LÍNEA B-1
            case 'soplado_b1_200ml':
                botellaNombre = 'Botella de 200 ml - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 200 ml B-1';
                break;
            case 'soplado_b1_500ml':
                botellaNombre = 'Botella de 500 ml - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 500 ml B-1';
                break;
            case 'soplado_b1_900ml':
                botellaNombre = 'Botella de 900 ml - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 900 ml B-1';
                break;
            case 'soplado_b1_1lt':
                botellaNombre = 'Botella de 1 Lt - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 1 lt B-1';
                break;
            case 'soplado_b1_2lt':
                botellaNombre = 'Botella de 2 Lt - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 2 lt B-1';
                break;

            // OTRAS MARCAS
            case 'soplado_donlalo_800ml':
                botellaNombre = 'Botella de 800ml - Don Lalo';
                etiquetaNombre = 'Etiqueta couche 90gr x 800 ml Don Lalo';
                break;
            case 'soplado_vega_900ml':
                botellaNombre = 'Botella VEGA x 900 ml';
                etiquetaNombre = null;
                break;
            default:
                throw new Error('Tipo de botella desconocido.');
        }

        // 1. Descontar la preforma elegida manualmente por el operador (stock en MILL)
        const preRes = await client.query('SELECT stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [preforma_nombre]);
        if (preRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `La preforma "${preforma_nombre}" no existe en el inventario.` });
        }
        const stockPreformaAnterior = Number(preRes.rows[0].stock) || 0;
        const cantidadPreformaMill = cantidadBotellas / 1000;
        await client.query(
            `UPDATE inventario SET stock = stock - $1 WHERE LOWER(nombre) = LOWER($2)`,
            [cantidadPreformaMill, preforma_nombre]
        );
        await actualizarEstadoArticulo(client, preforma_nombre);
        await registrarHistorial(client, {
            tipo: 'PRODUCCION', origen: 'soplado',
            producto: preforma_nombre,
            cantidad: cantidadPreformaMill, tipo_cambio: 'RESTA',
            stock_anterior: stockPreformaAnterior, stock_nuevo: stockPreformaAnterior - cantidadPreformaMill,
            usuario: usuarioResponsable(req, usuario),
            referencia: 'Descuento por soplado de ' + cantidadBotellas + ' uds de ' + botellaNombre
        });

        // 2. Descontar la etiqueta correspondiente automáticamente (stock en MILL)
        if (etiquetaNombre) {
            const etRes = await client.query('SELECT stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [etiquetaNombre]);
            if (etRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `La etiqueta "${etiquetaNombre}" no existe en el inventario.` });
            }
            const stockEtiquetaAnterior = Number(etRes.rows[0].stock) || 0;
            const cantidadEtiquetaMill = cantidadBotellas / 1000;
            await client.query(
                `UPDATE inventario SET stock = stock - $1 WHERE LOWER(nombre) = LOWER($2)`,
                [cantidadEtiquetaMill, etiquetaNombre]
            );
            await actualizarEstadoArticulo(client, etiquetaNombre);
            await registrarHistorial(client, {
                tipo: 'PRODUCCION', origen: 'soplado',
                producto: etiquetaNombre,
                cantidad: cantidadEtiquetaMill, tipo_cambio: 'RESTA',
                stock_anterior: stockEtiquetaAnterior, stock_nuevo: stockEtiquetaAnterior - cantidadEtiquetaMill,
                usuario: usuarioResponsable(req, usuario),
                referencia: 'Descuento por soplado de ' + cantidadBotellas + ' uds de ' + botellaNombre
            });
        }

        // 3. Aumentar stock de la botella fabricada en inventario
        const botRes = await client.query('SELECT stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [botellaNombre]);
        if (botRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `La botella "${botellaNombre}" no existe en el inventario. Crea el artículo primero.` });
        }
        const stockBotellaAnterior = Number(botRes.rows[0].stock) || 0;
        await client.query(
            `UPDATE inventario SET stock = stock + $1 WHERE LOWER(nombre) = LOWER($2)`,
            [cantidadBotellas, botellaNombre]
        );
        await actualizarEstadoArticulo(client, botellaNombre);
        await registrarHistorial(client, {
            tipo: 'PRODUCCION', origen: 'soplado',
            producto: botellaNombre,
            cantidad: cantidadBotellas, tipo_cambio: 'SUMA',
            stock_anterior: stockBotellaAnterior, stock_nuevo: stockBotellaAnterior + cantidadBotellas,
            usuario: usuarioResponsable(req, usuario),
            referencia: 'Producción soplado: ' + cantidadBotellas + ' uds ' + botellaNombre
        });

        // Guardar el reporte del día para la barra de estado y estadísticas
        await client.query(
            `INSERT INTO reportes_soplado (preforma_nombre, botella_tipo, botella_nombre, cantidad_botellas, usuario_registro)
             VALUES ($1, $2, $3, $4, $5)`,
            [preforma_nombre, botella_tipo, botellaNombre, cantidadBotellas, usuario || 'soplado_user']
        );

        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Producción de ${cantidadBotellas} unidades de ${botellaNombre} registrada. Se descontó la preforma "${preforma_nombre}" y su etiqueta.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al registrar soplado:', error);
        res.status(500).json({ success: false, mensaje: 'Error al procesar el reporte de soplado: ' + error.message });
    } finally {
        client.release();
    }
});

app.get('/api/soplado/reportes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reportes_soplado ORDER BY id DESC LIMIT 50');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/estado-lineas', async (req, res) => {
    try {
        const result = await pool.query('SELECT area, estado, usuario_registro, fecha_actualizacion, proximo_producto FROM estado_lineas');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/estado-linea', gEnvasado, async (req, res) => {
    try {
        const { area, estado, usuario, proximo_producto } = req.body;
        const areaValida = area === 'envasado' || area === 'soplado';
        const estadoValido = estado === 'EN MARCHA' || estado === 'PARADO';
        if (!areaValida || !estadoValido) {
            return res.status(400).json({ success: false, mensaje: 'Área o estado inválido.' });
        }
        const tieneSiguiente = proximo_producto !== undefined;
        await pool.query(
            `INSERT INTO estado_lineas (area, estado, usuario_registro, fecha_actualizacion, proximo_producto)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
             ON CONFLICT (area) DO UPDATE SET
                estado = EXCLUDED.estado,
                usuario_registro = EXCLUDED.usuario_registro,
                fecha_actualizacion = EXCLUDED.fecha_actualizacion,
                proximo_producto = CASE WHEN $5 THEN EXCLUDED.proximo_producto ELSE estado_lineas.proximo_producto END`,
            [area, estado, usuario || 'operador', tieneSiguiente ? proximo_producto : null, tieneSiguiente]
        );
        res.json({ success: true, area, estado, proximo_producto: tieneSiguiente ? proximo_producto : undefined });
    } catch (err) {
        console.error('Error al actualizar estado de línea:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- FUNCIÓN AUXILIAR: RECALCULAR ESTADO DE ARTÍCULOS SEGÚN STOCK ---
// Con id se actualiza por clave primaria (sin ambigüedad de nombres);
// por nombre es el camino legacy para los módulos que no usan recetas.
async function actualizarEstadoArticulo(q, nombre, id = null) {
    if (id) {
        await q.query(
            `UPDATE inventario SET estado = CASE WHEN stock <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END WHERE id = $1`,
            [id]
        );
        return;
    }
    await q.query(
        `UPDATE inventario SET estado = CASE WHEN stock <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END WHERE LOWER(nombre) = LOWER($1)`,
        [nombre]
    );
}

// --- FUNCIÓN AUXILIAR: HISTORIAL DE MOVIMIENTOS DE INVENTARIO ---
// La auditoría es obligatoria: si el movimiento de stock no queda registrado,
// el error sube y la transacción que lo llamó se revierte. Un stock movido sin
// rastro es indistinguible de un stock inventado.
//
// `tolerante: true` queda solo para los módulos fuera de este alcance (refinado),
// donde el comportamiento anterior era best-effort y no se cambia a la fuerza.
async function registrarHistorial(q, datos) {
    try {
        await q.query(
            `INSERT INTO historial_inventario (tipo, origen, producto, producto_key, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                datos.tipo || 'MOVIMIENTO',
                datos.origen || '',
                datos.producto || 'N/D',
                datos.producto_key || null,
                datos.articulo_id || null,
                Number(datos.cantidad) || 0,
                datos.tipo_cambio === 'RESTA' ? 'RESTA' : 'SUMA',
                datos.stock_anterior !== undefined && datos.stock_anterior !== null ? Number(datos.stock_anterior) : null,
                datos.stock_nuevo !== undefined && datos.stock_nuevo !== null ? Number(datos.stock_nuevo) : null,
                datos.usuario || 'sistema',
                datos.referencia || ''
            ]
        );
    } catch (err) {
        if (!datos.tolerante) throw err;
        console.error("No se pudo registrar en el historial de inventario:", err.message);
    }
}

// Resuelve el nombre de usuario priorizando la sesión (token) y luego el enviado por el formulario.
function usuarioResponsable(req, bodyUsuario) {
    return (req && req.usuario) || bodyUsuario || 'sistema';
}

// --- RECETAS: ahora gestionadas por BD (ver routes/recipes.js y services/recipeService.js) ---
// La lógica de recetas hardcoded ha sido movida a BD (tablas recetas y receta_insumos)
// Endpoints: /api/recetas/* (ver routes/recipes.js)

// --- ENVASADO: la producción de envasado se registra por /api/produccion/reporte ---

// --- FUNCIÓN AUXILIAR: EXTRAER CANTIDAD DE UN PDF CERCANA A UNA CLAVE DE PRODUCTO ---
function extraerCantidadPdf(textoPdf, claves) {
    const lineas = textoPdf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const regexU = /(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:UNIDADES?|UNID|UNI|UND|UN|U\.|UA|U|CAJAS?|CJ|PAQUETES?|PACKS?|BULTOS?|BALDES?)\b/i;
    const regexCant = /(?:CANT|CANTIDAD|TOTAL|P\.?CANT)[\s.:]*(\d{1,6}(?:[.,]\d{1,3})?)/i;
    const regexParen = /\(\s*(\d{1,6}(?:[.,]\d{1,3})?)\s*\)/;
    const capturar = (texto) => {
        if (!texto) return null;
        let m = texto.match(regexU);
        if (!m) m = texto.match(regexCant);
        if (!m) m = texto.match(regexParen);
        if (m) { const v = parseFloat(m[1].replace(',', '.')); if (v > 0 && v < 100000) return v; }
        return null;
    };
    for (const clave of claves) {
        const idx = lineas.findIndex(l => l.includes(clave));
        if (idx === -1) continue;
        for (const i of [idx, idx - 1, idx + 1]) {
            if (i < 0 || i >= lineas.length) continue;
            const v = capturar(lineas[i]);
            if (v !== null) return v;
        }
    }
    return null;
}

// ------------------ FUNCIONES AUXILIARES DEL LECTOR DE GUÍAS SUNAT ------------------

// Normaliza un texto para comparaciones: minúsculas y solo alfanumérico
function normalizarGuia(txt) {
    return (txt || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Convierte un alias de producto de la guía ("B-1 X 200 ML") en un patrón que
// tolera los espacios y guiones que el OCR mete entre los tokens. La "X" de
// separador es opcional porque la misma presentación aparece como "B-1 200 ML".
function regexDesdeAlias(alias) {
    const tokens = (alias || '').toUpperCase().match(/[A-Z]+|\d+/g) || [];
    const partes = tokens.map((t, i) => (t === 'X' && i > 0 ? '(?:[\\s\\-.]*X)?' : '[\\s\\-.]*' + t));
    return partes.length ? new RegExp(partes.join(''), 'i') : null;
}

// Cantidad de una fila de productos.
//
// En la guía el producto llega con su presentación pegada ("B-1 X 200 ML
// ACEITE DE SOYA"), así que el último número de la línea era la medida y no la
// cantidad pedida. Primero se borra el alias del producto y solo después se
// toma el último número que queda, que es la columna Cantidad. Si tras borrar
// el alias no queda ninguna cifra se devuelve null (y el item queda para
// revisión manual) en vez de inventar un número.
function extraerCantidadFila(linea, alias) {
    const reAlias = regexDesdeAlias(alias);
    const resto = reAlias ? linea.replace(reAlias, ' ') : linea;
    const numeros = (resto.match(/\d[\d.,]*/g) || [])
        .map(n => n.replace(/,/g, ''))
        .filter(n => /^\d+(\.\d+)?$/.test(n))
        .map(Number)
        .filter(v => v > 0 && v < 100000);
    if (numeros.length === 0) return { valor: null, avisos: [] };
    const avisos = [];
    if (numeros.length > 1) {
        avisos.push(`La fila "${linea.slice(0, 60)}" tiene varias cifras (${numeros.join(', ')}); se tomó la última como cantidad. Revísala.`);
    }
    return { valor: numeros[numeros.length - 1], avisos };
}

// Claques de productos tal como aparecen en la guía de remisión electrónica SUNAT
const PRODUCTOS_PDF_KEYWORDS = [
    { product_key: 'b1_1lt', nombres: ['B-1 X 1 LT', 'B-1 X 1L', 'B-1 1 LT', 'B-1 1L', 'B-1 X 1 L'] },
    { product_key: 'b1_900ml', nombres: ['B-1 X 900 ML', 'B-1 900ML', 'B-1 900 ML'] },
    { product_key: 'b1_500ml', nombres: ['B-1 X 500 ML', 'B-1 500 ML'] },
    { product_key: 'b1_200ml', nombres: ['B-1 X 200 ML', 'B-1 200 ML'] },
    { product_key: 'b1_2lt', nombres: ['B-1 X 2 LT', 'B-1 2 LT', 'B-1 2L', 'B-1 X 2 L'] },
    { product_key: 'b1_5lt', nombres: ['B-1 X 5 LT', 'B-1 5 LT', 'B-1 5L', 'B-1 X 5 L', 'B-1 X 5 L X 4'] },
    { product_key: 'donlalo_800ml', nombres: ['DON LALO X 800 ML', 'DON LALO 800ML', 'DON LALO 800 ML'] },
    { product_key: 'donlalo_20lt', nombres: ['DON LALO BALDE 20 LT', 'DON LALO 20 LT', 'DON LALO BALDE X 20 L'] },
    { product_key: 'belini_1lt', nombres: ['BELINI X 1 LT', 'BELINI 1 LT', 'BELINI 1L', 'BELINI X 1 L'] },
    { product_key: 'belini_2lt', nombres: ['BELINI X 2 LT', 'BELINI 2 LT', 'BELINI 2L', 'BELINI X 2 L'] },
    { product_key: 'belini_900ml', nombres: ['BELINI X 900 ML', 'BELINI 900ML', 'BELINI 900 ML'] },
    { product_key: 'belini_500ml', nombres: ['BELINI X 500 ML', 'BELINI 500 ML'] },
    { product_key: 'belini_200ml', nombres: ['BELINI X 200 ML', 'BELINI 200 ML'] },
    { product_key: 'belini_3lt', nombres: ['BELINI X 3 LT', 'BELINI 3 LT', 'BELINI X 3 L'] },
    { product_key: 'belini_5lt', nombres: ['BELINI X 5 LT', 'BELINI 5 LT', 'BELINI X 5 L'] },
    { product_key: 'belini_lata18lt', nombres: ['BELINI LATA 18 LT', 'BELINI 18 LT', 'BELINI LATA X 18 L'] },
    { product_key: 'belini_balde18lt', nombres: ['BELINI BALDE 18 LT', 'BELINI BALDE X 18 L', 'BELINI BALDE X 18 LT'] }
];

// Lee la tabla "Bienes por transportar" de la guía SUNAT (una fila por producto, cantidad al final)
function detectarItemsTabla(textoPdf) {
    const lineas = textoPdf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const idxIni = lineas.findIndex(l => /Bienes por [Tt]ransportar/i.test(l));
    const idxFin = lineas.findIndex(l => /Indicador de traslado|Datos del traslado|Datos de los veh[ií]culos|Datos de los conductores|representaci[óo]n impresa/i.test(l));
    const region = idxIni !== -1 ? lineas.slice(idxIni + 1, idxFin !== -1 ? idxFin : lineas.length) : lineas;

    const items = [];
    const advertencias = [];
    const contadorKeys = {};
    let noReconocidas = 0;

    for (const linea of region) {
        if (linea.length < 10) continue;
        if (/Peso Bruto|KGM|Indicador|Documentos|Observaci|^NO$|Bien normalizado|Descripci[oó]n Detallada|Partida arancelaria|Unidad de medida|^TOTAL|Datos del traslado|Número de|Principal:|Secundario|Habiltaci|TUCE|Certificado de|de la carga:|^normalizado|^medida$|^Cantidad$|^C[óo]digo$|^GTIN$|^SUNAT$|^Bien$|^Descripci|^Partida$|Fecha Emisi[oó]n|Motivo Traslado|Modalidad de Transporte|Número de Bultos|Número de placa|Raz[oó]n Social|Vendedor|Direcci[oó]n|Conductor|Licencia del conductor|^DESTINATARIO$|^ENVIO$|^TRANSPORTE$|^Item\b|^GUIA DE REMISI[OÓ]N|^Para consultar|^P\.?Partida|^P\.?Llegada|^T\d{3}-\d|^\d{1,2} de \d{1,2} de|^CORPORACION DON LALO|CIPRESES|LURIGANCHO|CAJAMARQUILLA/i.test(linea)) continue;
        const normLinea = normalizarGuia(linea);
        if (!normLinea) continue;

        // Se identifica el producto antes que nada: su presentación ("200 ML")
        // forma parte del alias y hay que quitarla para no leerla como cantidad.
        let prod = null;
        let alias = null;
        for (const p of PRODUCTOS_PDF_KEYWORDS) {
            if ((contadorKeys[p.product_key] || 0) >= 4) continue;
            const encontrado = p.nombres.find(n => normLinea.includes(normalizarGuia(n)));
            if (encontrado) { prod = p; alias = encontrado; break; }
        }

        // El mínimo de 15 caracteres sirve para descartar ruido, pero no se
        // aplica si la línea ya coincidió con un producto conocido: "B-1 X 1 LT"
        // es una fila válida y solo mide 10 caracteres.
        if (!prod) {
            if (normLinea.length < 15) continue;
            noReconocidas++;
            if (noReconocidas <= 5) {
                advertencias.push(`Línea del PDF sin reconocer (revísala): "${linea.slice(0, 80)}..."`);
            }
            continue;
        }

        contadorKeys[prod.product_key] = (contadorKeys[prod.product_key] || 0) + 1;
        const nombre = PRODUCTOS_TERMINADOS_MAP[prod.product_key] || prod.product_key;
        const { valor: cantidad, avisos } = extraerCantidadFila(linea, alias);
        items.push({ product_key: prod.product_key, nombre, cantidad, cantidad_auto: cantidad !== null });
        if (cantidad === null) {
            advertencias.push(`Se detectó "${nombre}" en el PDF sin una cantidad clara. Revísala en la lista.`);
        }
        advertencias.push(...avisos);
    }
    return { items, advertencias };
}

// Extrae las direcciones de partida y llegada de la guía SUNAT (bloque antes de "Punto de ...")
// Una dirección queda terminada cuando su último segmento con guion es una
// palabra suelta: la localidad ("JR. LAS BEGONIAS 123 - SAN MARTIN - LIMA") o
// el país ("AV. LOS CIPRESES 450 - LURIGANCHO - PERU"). El patrón anterior
// exigía un segmento de UNA sola palabra en el medio de la dirección, así que
// cualquier localidad de varias palabras no cerraba el patrón y se pegaba a la
// línea siguiente.
function extraerDireccionSUNAT(lineas) {
    const finAddr = /-\s*[A-ZÁÉÍÓÚÑÜ]{3,}\s*$/i;
    const esPlantaBelcen = (d) => /LOS CIPRESES|CAJAMARQUILLA|LURIGANCHO/i.test(d);
    const idxLabel = lineas.findIndex(l => /^Punto de (llegada|partida)/i.test(l));
    if (idxLabel === -1) return { partida: '', llegada: '' };

    let idxStart = -1;
    for (let i = 0; i < idxLabel; i++) {
        const l = lineas[i];
        if (/Fecha de inicio de Traslado/i.test(l) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(l.trim())) {
            idxStart = i;
            break;
        }
    }

    // La dirección puede empezar en la mismísima línea "Fecha de inicio de Traslado: 13/05/2026 <dirección>"
    let buf = '';
    if (idxStart !== -1) {
        const m0 = lineas[idxStart].match(/Fecha de inicio de Traslado.*?\d{1,2}\/\d{1,2}\/\d{4}\s*(.*)$/i);
        if (m0 && m0[1].trim()) buf = m0[1].replace(/^Venta\s+/i, '').trim();
    }

    const direcciones = [];
    const cerrar = (texto) => {
        const t = texto.trim();
        if (!t) return;
        // La guía solo trae dos direcciones. Si se acumularon más, la sobrante
        // se funde con la segunda en lugar de inventar un tercer destino.
        if (direcciones.length >= 2) {
            direcciones[1] = direcciones[1] + ' ' + t;
            return;
        }
        direcciones.push(t);
    };

    const inicio = idxStart !== -1 ? idxStart + 1 : 0;
    for (let i = inicio; i < idxLabel; i++) {
        const l = lineas[i].replace(/^Venta\s+/i, '').trim();
        if (l.length < 8 || !/[A-ZÁÉÍÓÚÑÜ]/.test(l)) continue;
        if (/^\d{1,2}\/\d{1,2}\/\d{4}\s*$/.test(l)) continue;
        if (/[:]/.test(l) && !/-/.test(l)) continue;
        buf = buf ? buf + ' ' + l : l;
        if (finAddr.test(buf)) {
            cerrar(buf);
            buf = '';
        }
    }
    if (buf.trim()) cerrar(buf);

    if (direcciones.length === 0) return { partida: '', llegada: '' };
    if (direcciones.length === 1) return { partida: '', llegada: direcciones[0] };

    let partida = direcciones[0];
    let llegada = direcciones[1];
    const d0Belcen = esPlantaBelcen(direcciones[0]);
    const d1Belcen = esPlantaBelcen(direcciones[1]);
    if (d0Belcen !== d1Belcen) {
        partida = d0Belcen ? direcciones[0] : direcciones[1];
        llegada = d0Belcen ? direcciones[1] : direcciones[0];
    }
    return { partida, llegada };
}

// Cabecera y transporte de la guía de remisión (emisión SUNAT o formato anterior)
function parsearCabeceraSUNAT(textoPdf) {
    const lineas = textoPdf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const res = { numero_guia: '', ruc: '', empresa: '', destino: '', punto_partida: '', placa: '', chofer: '', licencia: '' };

    let m = textoPdf.match(/N[°º.]?\s*([A-Z0-9]{2,8})\s*[-–]\s*(\d{4,8})/i);
    if (m) {
        res.numero_guia = (m[1] + '-' + m[2]).toUpperCase();
    } else {
        m = textoPdf.match(/([T|F|B]\s*0\d{2}\s*[-]\s*\d{1,8})/i);
        if (m) res.numero_guia = m[1].replace(/\s+/g, '').toUpperCase();
    }

    m = textoPdf.match(/Datos del\s+[Dd]estinatario\s*:?\s*(.+?)\s*-\s*REGISTRO\s*[UÚ]?NICO\s*DE\s*CONTRIBUYENTES\s*N[°º]?\s*(\d{11})/i);
    if (m) {
        res.empresa = m[1].trim();
        res.ruc = m[2];
    }

    if (!res.ruc) {
        m = textoPdf.match(/RUC\s*N[°º]?\s*(\d{11})/i);
        if (m) res.ruc = m[1];
    }
    if (!res.ruc) {
        m = textoPdf.match(/RUC:?\s*(\d{11})/i);
        if (m) res.ruc = m[1];
    }
    if (!res.empresa) {
        const seg = textoPdf.match(/N[°º.]\s*[A-Z]{1,4}\s*[-–]\s*\d{4,8}\s*\r?\n+\s*([A-ZÁÉÍÓÚÑÜ0-9.& ]{4,60})/i);
        if (seg) res.empresa = seg[1].trim();
    }
    if (!res.empresa) {
        const seg2 = textoPdf.match(/Datos del\s+[Rr]emitente\s*:?\s*(.+?)\s*-\s*(?:REGISTRO\s*[UÚ]?NICO\s*DE\s*CONTRIBUYENTES|RUC)\s*N[°º]?\s*(\d{11})/);
        if (seg2) res.empresa = seg2[1].trim();
    }
    if (!res.empresa) {
        m = textoPdf.match(/Raz[oó]n\s*[Ss]ocial:?\s*([A-ZÁÉÍÓÚÑÜ0-9.& /]{4,60})/i);
        if (m) res.empresa = m[1].trim();
    }

    const dirs = extraerDireccionSUNAT(lineas);
    res.punto_partida = dirs.partida;
    res.destino = dirs.llegada;
    if (!res.punto_partida) {
        const pp = textoPdf.match(/P\.?Partida:?\s*(?:\d{6}\s*-\s*)?([A-ZÁÉÍÓÚÑÜ].*)/i);
        if (pp) res.punto_partida = pp[1].trim();
    }
    if (!res.destino) {
        const ll = textoPdf.match(/P\.?Llegada:?\s*(?:\d{6}\s*-\s*)?([A-ZÁÉÍÓÚÑÜ].*)/i);
        if (ll) res.destino = ll[1].trim();
    }
    if (!res.destino) {
        const lleg = textoPdf.match(/P\.?Llegada[:\s]*[\d\s-]+(.*)/i);
        if (lleg) res.destino = lleg[1].trim();
        else {
            const dir = textoPdf.match(/Direcci[oó]n[:\s]*(.*)/i);
            if (dir) res.destino = dir[1].trim();
        }
    }

    let pm = textoPdf.match(/[Nn][°ºoóO0]?\.?\s*(?:úmero de placa del veh[ií]culo|umero de placa del vehiculo)[^\w]*:?\s*([A-Z]{2,3}[-–\s]?\d{3,4})/i);
    if (!pm) pm = textoPdf.match(/veh[ií]culo[^\w]*:?\s*([A-Z]{2,3}[-–\s]?\d{3,4})/i);
    if (!pm) pm = textoPdf.match(/Principal[:\s]+([A-Z]{2,3}[-–\s]?\d{3,4})/i);
    if (!pm) pm = textoPdf.match(/\b([A-Z]{2,3}[-–]\d{3,4})\b/i);
    if (pm) res.placa = pm[1].trim().replace(/\s+/g, '').toUpperCase();

    let cm = textoPdf.match(/Principal[:\s]+([A-ZÁÉÍÓÚÑÜ .]{3,}?)\s*-\s*DOCUMENTO NACIONAL/i);
    if (!cm) cm = textoPdf.match(/Conductor[:\s]*([A-ZÁÉÍÓÚÑÜ .]{3,}?)(?=\s*\r?\n|$|\s*(?:D[.\s]?N[.\s]?I|DNI|Licencia|LIC|Brevete|Placa|Veh[ií]culo|RUC)[:\s])/i);
    if (!cm) cm = textoPdf.match(/Conductor[:\s]*(\d{8})/i);
    if (cm) res.chofer = cm[1].trim().replace(/\s+/g, ' ');

    const lm = textoPdf.match(/Número de licencia de conducir[:\s]*([A-Z0-9][A-Z0-9-]*[0-9])/i)
        || textoPdf.match(/Número de lincencia de conducir[:\s]*([A-Z0-9][A-Z0-9-]*[0-9])/i)
        || textoPdf.match(/Licencia del conductor[:\s]*([A-Z0-9][A-Z0-9-]*[0-9])/i)
        || textoPdf.match(/Licencia[:\s]*([A-Z0-9][A-Z0-9-]*[0-9])/i);
    if (lm) res.licencia = lm[1].trim().toUpperCase();

    return res;
}

// OCR de guías escaneadas (worker único de tesseract.js en español)
let workerTesseractPromise = null;
function obtenerWorkerOCR() {
    if (!workerTesseractPromise) {
        workerTesseractPromise = tesseract.createWorker('spa', undefined, {
            cachePath: path.join(os.tmpdir(), 'tesseract-cache')
        });
    }
    return workerTesseractPromise;
}

async function ocrPdf(dataBuffer) {
    const pdfData = await new PDFParse({ data: dataBuffer });
    const screens = await pdfData.getScreenshot({ imageBuffer: true, scale: 2.5 });
    let texto = '';
    const worker = await obtenerWorkerOCR();
    for (const page of screens.pages) {
        if (!page || !page.data) continue;
        const { data } = await worker.recognize(Buffer.from(page.data));
        texto += (data.text || '') + '\n';
    }
    return texto.trim();
}

/* =====================================================================
   LECTOR DE DOCUMENTOS CON IA (Gemini + OCR local)
   Soporta imágenes (JPG/PNG/WebP/BMP/HEIC) y PDF (texto o escaneo).
   ===================================================================== */
const MIMES_IMAGEN = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/heic', 'image/tiff']);

function mimetypePorExt(nombre) {
    const ext = (nombre || '').toLowerCase().split('.').pop();
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'heic') return 'image/heic';
    return 'application/octet-stream';
}

function primeroNoVacio(...valores) {
    for (const v of valores) {
        if (v && String(v).trim()) return String(v).trim();
    }
    return '';
}

// Extrae el texto de un documento (imagen o PDF): texto nativo → OCR local → Gemini.
async function extraerTextoDocumento(dataBuffer, mimetype) {
    const advertencias = [];
    const esImagen = MIMES_IMAGEN.has(mimetype);

    if (esImagen) {
        try {
            const worker = await obtenerWorkerOCR();
            const { data } = await worker.recognize(Buffer.from(dataBuffer));
            const textoOCR = (data.text || '').trim();
            if (textoOCR.length >= 15) return { texto: textoOCR, metodo: 'ocr', advertencias };
            advertencias.push('El OCR local no reconoció la imagen; se intentará con IA.');
        } catch (err) {
            advertencias.push('Error en OCR local: ' + err.message);
        }
    } else if (mimetype === 'application/pdf') {
        try {
            const pdfData = await new PDFParse({ data: dataBuffer }).getText();
            const textoNativo = (pdfData.text || '').trim();
            if (textoNativo.length >= 30) return { texto: textoNativo, metodo: 'texto', advertencias };
            advertencias.push('El PDF no tiene texto nativo (parece escaneo), se aplicará OCR.');
        } catch (err) {
            advertencias.push('No se pudo extraer texto del PDF: ' + err.message);
        }
        try {
            const textoOCR = await ocrPdf(dataBuffer);
            if (textoOCR.length >= 15) return { texto: textoOCR, metodo: 'ocr', advertencias };
            advertencias.push('El OCR local no reconoció el escaneo; se intentará con IA.');
        } catch (err) {
            advertencias.push('Error en OCR del escaneo: ' + err.message);
        }
    }

    try {
        const ia = await analizarDocumentoConGemini(dataBuffer, mimetype);
        if (ia && ia.texto && ia.texto.trim().length >= 15) {
            advertencias.push('Texto reconocido con IA (Gemini).');
            return { texto: ia.texto.trim(), metodo: 'ia', advertencias };
        }
    } catch (err) {
        advertencias.push('La IA no pudo leer el documento: ' + err.message);
    }

    return { texto: '', metodo: 'texto', advertencias };
}

// Cabecera legible para vigilancia (ingresos) a partir de texto plano.
function componerCamposDesdeTexto(texto) {
    const cabecera = parsearCabeceraSUNAT(texto);
    const res = {
        campos: {
            tipo_documento: '',
            numero_guia: cabecera.numero_guia,
            proveedor: cabecera.empresa,
            ruc: cabecera.ruc,
            empresa: cabecera.empresa,
            chofer: cabecera.chofer,
            dni_chofer: '',
            placa: cabecera.placa,
            partida: cabecera.punto_partida,
            destino: cabecera.destino,
            licencia: cabecera.licencia
        },
        items: []
    };
    const rem = texto.match(/Datos del\s+[Rr]emitente\s*:?\s*(.+?)\s*-\s*(?:REGISTRO\s*[UÚ]?NICO\s*DE\s*CONTRIBUYENTES|RUC)\s*N[°º]?\s*(\d{11})/i);
    if (rem) {
        res.campos.proveedor = rem[1].trim();
        if (!res.campos.ruc) res.campos.ruc = rem[2];
    }
    const mDNI = texto.match(/D[.\s]?N[.\s]?I[:\s]*[N°º]?\s*(\d{8})/i);
    if (mDNI) res.campos.dni_chofer = mDNI[1];
    const t = texto.toLowerCase();
    if (t.includes('factura')) res.campos.tipo_documento = 'FACTURA';
    else if (t.includes('guia') || t.includes('guía') || t.includes('remisi')) res.campos.tipo_documento = 'GUIA DE REMISION';
    else res.campos.tipo_documento = 'OTRO';

    // ítems en bruto de la sección "Bienes por transportar" (insumos, no catálogo de salidas)
    const rechazar = /^(?:BIENES\s+POR\s+TRANSPORTAR|Datos del|N[°º]\.?\s|Fecha|RUC|N[Uu]mero de|P\.?Partida|P\.?Llegada|Conductor|Licencia|D\.?N\.?I|Principal|Secundario|Raz[oó]n|Direcci[oó]n|Unidad de medida|Cantidad|Descripci|C[oó]digo|^Item\b|^TOTAL|^Peso|^T\d{3})/i;
    const filas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const candidatos = [];
    let enBienes = false;
    for (const fila of filas) {
        if (/bienes por transportar/i.test(fila)) { enBienes = true; continue; }
            const m = fila.match(/^(.{3,120}?)[\s]+([\d][\d.,]{1,10})$/);
        if (!m) continue;
        const nombre = m[1].trim().replace(/\s+/g, ' ');
        if (enBienes && !rechazar.test(nombre) && !/^[A-Z]{2,3}-?\d{3,4}$/i.test(nombre)) {
            candidatos.push({ nombre, cantidad_guia: Number(m[2].replace(/\./g, '').replace(',', '.')) || 0 });
        }
    }
    if (candidatos.length === 0) {
        for (const fila of filas) {
        const m = fila.match(/^(.{3,120}?)[\s]+([\d][\d.,]{1,10})$/);
            if (!m) continue;
            const nombre = m[1].trim().replace(/\s+/g, ' ');
            if (/^(?:botella|etiqueta|tapa|ca[ja]s?|preforma|paleta|insumo|aceite|don lalo|belini|corporacion)/i.test(nombre) && !rechazar.test(nombre)) {
                candidatos.push({ nombre, cantidad_guia: Number(m[2].replace(/\./g, '').replace(',', '.')) || 0 });
            }
        }
    }
    const porNombre = new Map();
    for (const it of candidatos) {
        const clave = it.nombre.toUpperCase();
        if (porNombre.has(clave)) porNombre.get(clave).cantidad_guia += it.cantidad_guia;
        else porNombre.set(clave, { nombre: it.nombre, cantidad_guia: it.cantidad_guia });
    }
    res.items = Array.from(porNombre.values());
    return res;
}

// --- LECTOR INTELIGENTE DE DOCUMENTOS PARA SALIDAS ---
app.post('/api/salidas/leer-pdf', gIA, upload.single('archivo_guia'), async (req, res) => {
    const limpiarArchivo = () => { if (req.file) fs.promises.unlink(req.file.path).catch(() => {}); };
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, mensaje: 'No se subió ningún archivo.' });
        }

        const dataBuffer = fs.readFileSync(req.file.path);
        const mimetype = req.file.mimetype || mimetypePorExt(req.file.originalname);
        const { texto: textoPdf, metodo, advertencias: advertenciasExtraccion } = await extraerTextoDocumento(dataBuffer, mimetype);
        const advertencias = advertenciasExtraccion.slice();

        if (!textoPdf || textoPdf.trim().length < 15) {
            return res.json({ success: false, mensaje: 'No se pudo reconocer contenido legible en el documento (ni texto ni OCR). Carga los datos manualmente.' });
        }

        const cabecera = parsearCabeceraSUNAT(textoPdf);
        let chofer_licencia = [cabecera.chofer, cabecera.licencia ? 'Lic: ' + cabecera.licencia : ''].filter(Boolean).join(' - ');

        // Refuerzo con IA (Gemini): completa cabecera e ítems cuando los parsers locales no alcanzan.
        let itemsIA = null;
        let usadoGemini = false;
        try {
            const ia = await analizarDocumentoConGemini(dataBuffer, mimetype, textoPdf);
            if (ia && (Object.values(ia.campos || {}).some(v => String(v).trim()) || (Array.isArray(ia.items) && ia.items.length))) {
                const c = ia.campos || {};
                cabecera.numero_guia = primeroNoVacio(c.numero_guia, cabecera.numero_guia);
                cabecera.ruc = primeroNoVacio(c.ruc, cabecera.ruc);
                cabecera.empresa = primeroNoVacio(c.empresa, c.proveedor, cabecera.empresa);
                cabecera.destino = primeroNoVacio(c.destino, cabecera.destino);
                cabecera.punto_partida = primeroNoVacio(c.partida, cabecera.punto_partida);
                cabecera.placa = primeroNoVacio(c.placa, cabecera.placa).replace(/\s+Principal$/i, '');
                cabecera.chofer = primeroNoVacio(c.chofer, cabecera.chofer);
                cabecera.licencia = primeroNoVacio(c.licencia, cabecera.licencia);
                chofer_licencia = [cabecera.chofer, cabecera.licencia ? 'Lic: ' + cabecera.licencia : ''].filter(Boolean).join(' - ');
                if (Array.isArray(ia.items) && ia.items.length > 0) itemsIA = ia.items;
                advertencias.unshift('Datos leídos con IA (Gemini). Revisa cantidades y campos antes de registrar.');
                usadoGemini = true;
            }
        } catch (errG) {
            console.error('Gemini no disponible en salidas:', errG.message);
        }

        const { items: itemsTabla, advertencias: advertenciasTabla } = detectarItemsTabla(textoPdf);
        let itemsDetectados;
        if (itemsIA && itemsIA.length > 0) {
            itemsDetectados = itemsIA.map(it => ({
                product_key: it.product_key || '',
                nombre: it.nombre || '',
                cantidad: Number(it.cantidad ?? it.cantidad_guia) || 0,
                cantidad_auto: true
            }));
        } else {
            const porProd = new Map();
            for (const it of itemsTabla) {
                const clave = it.product_key || it.nombre;
                const prev = porProd.get(clave);
                if (prev) prev.cantidad += Number(it.cantidad) || 0;
                else porProd.set(clave, { ...it, cantidad: Number(it.cantidad) || 0 });
            }
            itemsDetectados = Array.from(porProd.values());
            advertencias.push(...advertenciasTabla);
        }

        if (itemsDetectados.length === 0) {
            const ptRes = await pool.query('SELECT * FROM producto_terminado');
            for (const pt of ptRes.rows) {
                const nombreBusq = pt.nombre_producto.toLowerCase().replace('aceite de soya', '').trim();
                if (!nombreBusq) continue;
                if (!textoPdf.toLowerCase().includes(nombreBusq)) continue;
                const cantidadDetectada = extraerCantidadPdf(textoPdf, [pt.nombre_producto, pt.nombre_producto.toLowerCase(), nombreBusq]);
                itemsDetectados.push({
                    product_key: pt.producto_key,
                    nombre: pt.nombre_producto,
                    cantidad: cantidadDetectada,
                    cantidad_auto: !!cantidadDetectada
                });
                if (!cantidadDetectada) {
                    advertencias.push(`Se detectó "${pt.nombre_producto}" en el PDF pero no se pudo leer su cantidad. Agrega la cantidad manualmente en la lista.`);
                }
            }
            if (itemsDetectados.length === 0) {
                advertencias.push('No se reconocieron productos del catálogo en el PDF. Si la guía trae ítems, agrégalos manualmente en la lista.');
            }
        }

        if (metodo === 'ocr') {
            advertencias.unshift('Datos leídos mediante OCR (la guía era un escaneo). Revisa cantidades y campos antes de registrar.');
        }

        res.json({
            success: true,
            metodo,
            usadoGemini,
            datos: {
                numero_guia: cabecera.numero_guia,
                ruc: cabecera.ruc,
                empresa: cabecera.empresa,
                destino: cabecera.destino,
                punto_partida: cabecera.punto_partida,
                chofer_licencia,
                placa: cabecera.placa,
                items: itemsDetectados,
                advertencias
            }
        });
    } catch (err) {
        console.error("Error al leer PDF:", err);
        res.status(500).json({ success: false, mensaje: 'No se pudo leer el PDF: ' + err.message });
    } finally {
        limpiarArchivo();
    }
});

// --- LECTOR IA GENÉRICO PARA VIGILANCIA / ALMACÉN (imagen o PDF, rellena campos) ---
app.post('/api/documento/leer', gIA, upload.single('archivo_documento'), async (req, res) => {
    const limpiarArchivo = () => { if (req.file) fs.promises.unlink(req.file.path).catch(() => {}); };
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, mensaje: 'No se subió ninguna imagen o PDF.' });
        }

        const dataBuffer = fs.readFileSync(req.file.path);
        const mimetype = req.file.mimetype || mimetypePorExt(req.file.originalname);
        const { texto, metodo, advertencias: advertenciasExt } = await extraerTextoDocumento(dataBuffer, mimetype);
        const advertencias = advertenciasExt.slice();

        let campos = {};
        let items = [];
        let textoReconocido = texto;
        let usadoGemini = false;

        if (texto && texto.trim().length >= 15) {
            let ia = null;
            try { ia = await analizarDocumentoConGemini(dataBuffer, mimetype, texto); }
            catch (err) { advertencias.push('La IA falló: ' + err.message); }

            const hayCamposIA = ia && ia.campos && Object.values(ia.campos).some(v => String(v).trim());
            if (hayCamposIA || (ia && Array.isArray(ia.items) && ia.items.length > 0)) {
                campos = ia.campos || {};
                items = (Array.isArray(ia.items) ? ia.items : []).map(it => ({
                    nombre: it.nombre || '',
                    cantidad_guia: Number(it.cantidad_guia ?? it.cantidad) || 0
                }));
                textoReconocido = ia.texto || texto;
                usadoGemini = true;
                advertencias.push('Datos leídos con IA (Gemini). REVÍSALOS antes de guardar.');
            } else {
                const comp = componerCamposDesdeTexto(texto);
                campos = comp.campos;
                items = comp.items;
            }
        }

        if (!Object.keys(campos).length) {
            // Último intento con IA incluso si el texto local fue pobre.
            try {
                const ia = await analizarDocumentoConGemini(dataBuffer, mimetype, texto);
                if (ia && ia.campos) {
                    campos = ia.campos;
                    items = (Array.isArray(ia.items) ? ia.items : []).map(it => ({
                        nombre: it.nombre || '',
                        cantidad_guia: Number(it.cantidad_guia ?? it.cantidad) || 0
                    }));
                    textoReconocido = ia.texto || texto;
                    usadoGemini = true;
                    advertencias.push('Datos leídos con IA (Gemini). REVÍSALOS antes de guardar.');
                }
            } catch (err) {
                advertencias.push('La IA no pudo leer el documento: ' + err.message);
            }
        }

        if (campos.placa) campos.placa = String(campos.placa).replace(/\s+Principal$/i, '');
        const reconocioGuia = !!(campos.numero_guia || campos.proveedor || campos.ruc || campos.placa || campos.chofer);
        res.json({ success: true, metodo, usadoGemini, reconocioGuia, texto: textoReconocido, campos, items, advertencias });
    } catch (err) {
        console.error('Error al leer documento:', err);
        res.status(500).json({ success: false, mensaje: 'No se pudo leer el documento: ' + err.message });
    } finally {
        limpiarArchivo();
    }
});

// --- SALIDAS DE ALMACÉN ---
app.post('/api/salidas/registrar', gAlmacen, upload.single('archivo_guia'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, fecha_salida, usuario, items_json } = req.body;
        const items = JSON.parse(items_json || '[]');
        const despachoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

        if (items.length === 0) {
            return res.status(400).json({ success: false, mensaje: 'Debe incluir al menos un producto en el despacho.' });
        }

        await client.query('BEGIN');
        const estadoGuia = tipo_registro === 'CON GUIA' ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';
        const guiaFinal = numero_guia || 'S/N';
        const guia_url = req.file ? `/uploads/${req.file.filename}` : null;

        for (const item of items) {
            const idArticuloFinal = item.articulo_id ? parseInt(item.articulo_id) : null;
            const productoKeyFinal = item.producto_key || null;
            const cantidad = parseFloat(item.cantidad);
            const nombreItem = (item.nombre || productoKeyFinal || 'producto sin nombre').toString();

            if (!cantidad || isNaN(cantidad) || cantidad <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `Cantidad inválida para "${nombreItem}". Verifica cada ítem antes de registrar.` });
            }
            if (!productoKeyFinal && !idArticuloFinal) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `El ítem "${nombreItem}" no tiene producto asociado. Vuelve a seleccionarlo.` });
            }

            if (productoKeyFinal) {
                const ptRes = await client.query('SELECT stock_cajas FROM producto_terminado WHERE producto_key = $1', [productoKeyFinal]);
                if (ptRes.rows.length === 0 || Number(ptRes.rows[0].stock_cajas) < cantidad) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `Stock insuficiente de producto terminado para "${nombreItem}" (disponible: ${ptRes.rows.length ? ptRes.rows[0].stock_cajas : 0}).` });
                }
            } else if (idArticuloFinal) {
                const invRes = await client.query('SELECT stock FROM inventario WHERE id = $1', [idArticuloFinal]);
                if (invRes.rows.length === 0 || Number(invRes.rows[0].stock) < cantidad) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `Stock insuficiente de "${nombreItem}" (disponible: ${invRes.rows.length ? invRes.rows[0].stock : 0}).` });
                }
            }

            if (productoKeyFinal) {
                const st = await client.query('SELECT nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1', [productoKeyFinal]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock_cajas) || 0 : 0;
                await client.query(`UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE producto_key = $2`, [cantidad, productoKeyFinal]);
                await registrarHistorial(client, {
                    tipo: 'SALIDA', origen: 'salidas',
                    producto: st.rows.length > 0 ? st.rows[0].nombre_producto : nombreItem,
                    producto_key: productoKeyFinal,
                    cantidad, tipo_cambio: 'RESTA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior - cantidad,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Despacho N° ' + despachoId + ' - guía ' + guiaFinal
                });
            } else if (idArticuloFinal) {
                const st = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [idArticuloFinal]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock) || 0 : 0;
                await client.query(`UPDATE inventario SET stock = stock - $1 WHERE id = $2`, [cantidad, idArticuloFinal]);
                if (item.nombre) await actualizarEstadoArticulo(client, item.nombre);
                await registrarHistorial(client, {
                    tipo: 'SALIDA', origen: 'salidas',
                    producto: st.rows.length > 0 ? st.rows[0].nombre : nombreItem,
                    articulo_id: idArticuloFinal,
                    cantidad, tipo_cambio: 'RESTA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior - cantidad,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Despacho N° ' + despachoId + ' - guía ' + guiaFinal
                });
            }

            let targetArticuloId = idArticuloFinal;
            if (!targetArticuloId && productoKeyFinal) {
                const matchInv = await client.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [item.nombre]);
                if (matchInv.rows.length > 0) targetArticuloId = matchInv.rows[0].id;
            }

            await client.query(`
                INSERT INTO salidas_almacen 
                (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, articulo_id, cantidad_salida, usuario_registro, estado_guia, guia_url, despacho_id, producto_key)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);
            `, [
                fecha_salida || new Date(), tipo_registro, guiaFinal, 
                empresa || 'N/A', ruc || 'N/A', destino || 'N/A', 
                chofer_licencia || 'N/A', placa || 'N/A', punto_partida || 'Almacén Principal', 
                targetArticuloId, cantidad, usuario || 'almacen_user', estadoGuia, guia_url, despachoId, productoKeyFinal
            ]);
        }

        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Despacho de ${items.length} ítem(s) registrado correctamente.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error al registrar salida:", err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar la salida: ' + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/salidas/regularizar', gAlmacen, async (req, res) => {
    try {
        const { salida_id, nuevo_numero_guia } = req.body;
        await pool.query(`UPDATE salidas_almacen SET numero_guia = $1, estado_guia = 'REGULARIZADO' WHERE id = $2`, [nuevo_numero_guia, salida_id]);
        res.json({ success: true, mensaje: 'Guía regularizada con éxito.' });
    } catch (err) {
        console.error("Error al regularizar guía:", err);
        res.status(500).json({ success: false, mensaje: 'Error al regularizar guía: ' + err.message });
    }
});

app.post('/api/salidas/eliminar', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const { despacho_id, salida_id } = req.body;
        let filas = [];
        if (despacho_id) {
            const r = await client.query('SELECT * FROM salidas_almacen WHERE despacho_id = $1', [despacho_id]);
            filas = r.rows;
        }
        if (filas.length === 0 && salida_id) {
            const r = await client.query('SELECT * FROM salidas_almacen WHERE id = $1', [salida_id]);
            filas = r.rows;
        }
        if (filas.length === 0) {
            return res.status(404).json({ success: false, mensaje: 'No se encontró el despacho a eliminar.' });
        }

        await client.query('BEGIN');
        let borradas = 0;
        for (const fila of filas) {
            const cantidad = parseFloat(fila.cantidad_salida) || 0;
            if (fila.producto_key) {
                const st = await client.query('SELECT nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1', [fila.producto_key]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock_cajas) || 0 : 0;
                await client.query(`UPDATE producto_terminado SET stock_cajas = stock_cajas + $1 WHERE producto_key = $2`, [cantidad, fila.producto_key]);
                await registrarHistorial(client, {
                    tipo: 'DEVOLUCION', origen: 'salidas',
                    producto: st.rows.length > 0 ? st.rows[0].nombre_producto : fila.producto_key,
                    producto_key: fila.producto_key,
                    cantidad, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidad,
                    usuario: usuarioResponsable(req, req.body.usuario),
                    referencia: 'Despacho eliminado N° ' + (fila.despacho_id || fila.id)
                });
            } else if (fila.articulo_id) {
                const st = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [fila.articulo_id]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock) || 0 : 0;
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidad, fila.articulo_id]);
                const nombreRow = await client.query('SELECT nombre FROM inventario WHERE id = $1', [fila.articulo_id]);
                if (nombreRow.rows.length > 0) await actualizarEstadoArticulo(client, nombreRow.rows[0].nombre);
                await registrarHistorial(client, {
                    tipo: 'DEVOLUCION', origen: 'salidas',
                    producto: st.rows.length > 0 ? st.rows[0].nombre : 'Artículo #' + fila.articulo_id,
                    articulo_id: fila.articulo_id,
                    cantidad, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidad,
                    usuario: usuarioResponsable(req, req.body.usuario),
                    referencia: 'Despacho eliminado N° ' + (fila.despacho_id || fila.id)
                });
            }
            await client.query('DELETE FROM salidas_almacen WHERE id = $1', [fila.id]);
            borradas++;
        }
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Despacho eliminado y stock restaurado (${borradas} ítem(s)).` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error al eliminar salida:", err);
        res.status(500).json({ success: false, mensaje: 'Error al eliminar la salida: ' + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/salidas/editar', gAlmacen, upload.single('archivo_guia'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { despacho_id, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, fecha_salida, usuario, items_json } = req.body;
        const items = JSON.parse(items_json || '[]');

        if (!despacho_id) return res.status(400).json({ success: false, mensaje: 'Falta el identificador del despacho.' });
        if (items.length === 0) return res.status(400).json({ success: false, mensaje: 'Debe incluir al menos un producto.' });

        const filas = (await client.query('SELECT * FROM salidas_almacen WHERE despacho_id = $1', [despacho_id])).rows;
        if (filas.length === 0) return res.status(404).json({ success: false, mensaje: 'No se encontró el despacho a editar.' });

        await client.query('BEGIN');

        for (const fila of filas) {
            const cantidad = parseFloat(fila.cantidad_salida) || 0;
            if (fila.producto_key) {
                const st = await client.query('SELECT nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1', [fila.producto_key]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock_cajas) || 0 : 0;
                await client.query(`UPDATE producto_terminado SET stock_cajas = stock_cajas + $1 WHERE producto_key = $2`, [cantidad, fila.producto_key]);
                await registrarHistorial(client, {
                    tipo: 'DEVOLUCION', origen: 'salidas_editar',
                    producto: st.rows.length > 0 ? st.rows[0].nombre_producto : fila.producto_key,
                    producto_key: fila.producto_key,
                    cantidad, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidad,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Despacho editado N° ' + despacho_id
                });
            } else if (fila.articulo_id) {
                const st = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [fila.articulo_id]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock) || 0 : 0;
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidad, fila.articulo_id]);
                const nombreRow = await client.query('SELECT nombre FROM inventario WHERE id = $1', [fila.articulo_id]);
                if (nombreRow.rows.length > 0) await actualizarEstadoArticulo(client, nombreRow.rows[0].nombre);
                await registrarHistorial(client, {
                    tipo: 'DEVOLUCION', origen: 'salidas_editar',
                    producto: st.rows.length > 0 ? st.rows[0].nombre : 'Artículo #' + fila.articulo_id,
                    articulo_id: fila.articulo_id,
                    cantidad, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidad,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Despacho editado N° ' + despacho_id
                });
            }
            await client.query('DELETE FROM salidas_almacen WHERE id = $1', [fila.id]);
        }

        const estadoGuia = tipo_registro === 'CON GUIA' ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';
        const guiaFinal = numero_guia || 'S/N';
        const guia_url = req.file ? `/uploads/${req.file.filename}` : (filas[0].guia_url || null);

        for (const item of items) {
            const idArticuloFinal = item.articulo_id ? parseInt(item.articulo_id) : null;
            const productoKeyFinal = item.producto_key || null;
            const cantidad = parseFloat(item.cantidad);
            const nombreItem = (item.nombre || productoKeyFinal || 'producto sin nombre').toString();

            if (!cantidad || isNaN(cantidad) || cantidad <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `Cantidad inválida para "${nombreItem}". Verifica cada ítem antes de guardar.` });
            }
            if (!productoKeyFinal && !idArticuloFinal) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `El ítem "${nombreItem}" no tiene producto asociado. Vuelve a seleccionarlo.` });
            }

            if (productoKeyFinal) {
                const ptRes = await client.query('SELECT stock_cajas FROM producto_terminado WHERE producto_key = $1', [productoKeyFinal]);
                if (ptRes.rows.length === 0 || Number(ptRes.rows[0].stock_cajas) < cantidad) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `Stock insuficiente de producto terminado para "${nombreItem}" (disponible: ${ptRes.rows.length ? ptRes.rows[0].stock_cajas : 0}).` });
                }
            } else if (idArticuloFinal) {
                const invRes = await client.query('SELECT stock FROM inventario WHERE id = $1', [idArticuloFinal]);
                if (invRes.rows.length === 0 || Number(invRes.rows[0].stock) < cantidad) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `Stock insuficiente de "${nombreItem}" (disponible: ${invRes.rows.length ? invRes.rows[0].stock : 0}).` });
                }
            }

            if (productoKeyFinal) {
                const st = await client.query('SELECT nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1', [productoKeyFinal]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock_cajas) || 0 : 0;
                await client.query(`UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE producto_key = $2`, [cantidad, productoKeyFinal]);
                await registrarHistorial(client, {
                    tipo: 'SALIDA', origen: 'salidas',
                    producto: st.rows.length > 0 ? st.rows[0].nombre_producto : nombreItem,
                    producto_key: productoKeyFinal,
                    cantidad, tipo_cambio: 'RESTA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior - cantidad,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Edición despacho N° ' + despacho_id + ' - guía ' + guiaFinal
                });
            } else if (idArticuloFinal) {
                const st = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [idArticuloFinal]);
                const stockAnterior = st.rows.length > 0 ? Number(st.rows[0].stock) || 0 : 0;
                await client.query(`UPDATE inventario SET stock = stock - $1 WHERE id = $2`, [cantidad, idArticuloFinal]);
                if (item.nombre) await actualizarEstadoArticulo(client, item.nombre);
                await registrarHistorial(client, {
                    tipo: 'SALIDA', origen: 'salidas',
                    producto: st.rows.length > 0 ? st.rows[0].nombre : nombreItem,
                    articulo_id: idArticuloFinal,
                    cantidad, tipo_cambio: 'RESTA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior - cantidad,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Edición despacho N° ' + despacho_id + ' - guía ' + guiaFinal
                });
            }

            let targetArticuloId = idArticuloFinal;
            if (!targetArticuloId && productoKeyFinal) {
                const matchInv = await client.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [item.nombre]);
                if (matchInv.rows.length > 0) targetArticuloId = matchInv.rows[0].id;
            }

            await client.query(`
                INSERT INTO salidas_almacen 
                (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, articulo_id, cantidad_salida, usuario_registro, estado_guia, guia_url, despacho_id, producto_key)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);
            `, [
                fecha_salida || new Date(), tipo_registro, guiaFinal,
                empresa || 'N/A', ruc || 'N/A', destino || 'N/A',
                chofer_licencia || 'N/A', placa || 'N/A', punto_partida || 'Almacén Principal',
                targetArticuloId, cantidad, usuario || 'almacen_user', estadoGuia, guia_url, despacho_id, productoKeyFinal
            ]);
        }

        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Despacho actualizado (${items.length} ítem(s)) y stock recalculado.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error al editar salida:", err);
        res.status(500).json({ success: false, mensaje: 'Error al editar la salida: ' + err.message });
    } finally {
        client.release();
    }
});

app.get('/api/salidas/historial', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, 
                   CASE WHEN s.producto_key IS NOT NULL 
                        THEN COALESCE(pt.nombre_producto, i.nombre, 'Producto General') 
                        ELSE COALESCE(i.nombre, pt.nombre_producto, 'Producto General') END as articulo_nombre, 
                   COALESCE(i.unidad_medida, 'CAJAS') as unidad_medida 
            FROM salidas_almacen s
            LEFT JOIN inventario i ON s.articulo_id = i.id
            LEFT JOIN producto_terminado pt ON s.producto_key = pt.producto_key
            ORDER BY s.id DESC LIMIT 50
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Error en historial salidas:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener historial de salidas: ' + err.message });
    }
});

// --- AUDITORÍA: ENTRADAS (VIGILANCIA + ALMACÉN) Y SALIDAS ---
app.get('/api/auditoria/entradas', gAuditoria, async (req, res) => {
    try {
        const vig = await pool.query(`SELECT * FROM ingresos_vigilancia ORDER BY fecha_ingreso DESC`);
        const alm = await pool.query(`SELECT * FROM registro_ingresos_almacen ORDER BY fecha_registro DESC, id DESC`);

        const fotoPorGuia = {};
        vig.rows.forEach(v => {
            const g = (v.numero_guia || '').trim();
            if (g && v.foto_url && !fotoPorGuia[g]) fotoPorGuia[g] = v.foto_url;
        });

        const entradas = [];
        vig.rows.forEach(v => {
            let items = [];
            try { items = JSON.parse(v.items_json || '[]'); } catch (e) { items = []; }
            if (items.length > 0) {
                items.forEach(p => {
                    entradas.push({
                        fecha: v.fecha_ingreso,
                        numero_guia: v.numero_guia,
                        proveedor: v.proveedor,
                        producto: p.nombre || 'N/D',
                        cantidad: p.cantidad_fisica !== undefined && p.cantidad_fisica !== null ? p.cantidad_fisica : 0,
                        foto_url: v.foto_url,
                        origen: 'VIGILANCIA'
                    });
                });
            } else {
                entradas.push({
                    fecha: v.fecha_ingreso,
                    numero_guia: v.numero_guia,
                    proveedor: v.proveedor,
                    producto: v.producto_textual || 'N/D',
                    cantidad: v.cantidad || 0,
                    foto_url: v.foto_url,
                    origen: 'VIGILANCIA'
                });
            }
        });

        alm.rows.forEach(a => {
            const g = (a.numero_guia || '').trim();
            entradas.push({
                fecha: a.fecha_registro,
                numero_guia: a.numero_guia,
                proveedor: a.proveedor || 'N/D',
                producto: a.producto_nombre || 'N/D',
                cantidad: a.cantidad !== undefined && a.cantidad !== null ? a.cantidad : 0,
                foto_url: fotoPorGuia[g] || null,
                origen: 'ALMACEN'
            });
        });

        entradas.sort((x, y) => new Date(y.fecha || 0) - new Date(x.fecha || 0));
        res.json(entradas);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/auditoria/vigilancia', gAuditoria, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ingresos_vigilancia ORDER BY id DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/auditoria/salidas', gAuditoria, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*,
                   CASE WHEN s.producto_key IS NOT NULL 
                        THEN COALESCE(pt.nombre_producto, i.nombre, 'Producto General') 
                        ELSE COALESCE(i.nombre, pt.nombre_producto, 'Producto General') END as articulo_nombre
            FROM salidas_almacen s
            LEFT JOIN inventario i ON s.articulo_id = i.id
            LEFT JOIN producto_terminado pt ON s.producto_key = pt.producto_key
            ORDER BY s.id DESC LIMIT 300
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- AUDITORÍA: HISTORIAL DE MOVIMIENTOS DE INVENTARIO ---
app.get('/api/auditoria/historial', gAuditoria, async (req, res) => {
    try {
        const { tipo, desde, hasta, q } = req.query;
        const params = [];
        const filtros = [];

        filtros.push(`$1 = '' OR tipo = $1`);
        params.push(String(tipo || '').trim());

        filtros.push(`$2 = '' OR fecha >= $2::timestamp`);
        params.push(String(desde || '').trim());

        filtros.push(`$3 = '' OR fecha <= ($3::timestamp + interval '1 day')`);
        params.push(String(hasta || '').trim());

        const busqueda = String(q || '').trim();
        filtros.push(`$4 = '' OR LOWER(producto) LIKE LOWER($4) OR LOWER(COALESCE(usuario,'')) LIKE LOWER($4) OR LOWER(COALESCE(referencia,'')) LIKE LOWER($4)`);
        params.push('%' + busqueda + '%');

        const result = await pool.query(`
            SELECT * FROM historial_inventario
            WHERE ${filtros.join(' AND ')}
            ORDER BY fecha DESC, id DESC
            LIMIT 500
        `, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- FUNCIONES AUXILIARES DE PRODUCCIÓN ---
function detectarProductoTipo(presentacion) {
    const p = presentacion.toLowerCase();
    if (p.includes('b-1 200 ml') || p.includes('b1_200ml')) return 'b1_200ml';
    else if (p.includes('b-1 500 ml') || p.includes('b1_500ml')) return 'b1_500ml';
    else if (p.includes('b-1 900 ml') || p.includes('b1_900ml')) return 'b1_900ml';
    else if (p.includes('b-1 1 lt') || p.includes('b1_1lt')) return 'b1_1lt';
    else if (p.includes('b-1 2 lt') || p.includes('b1_2lt')) return 'b1_2lt';
    else if (p.includes('b-1 5 lt') || p.includes('b1_5lt')) return 'b1_5lt';
    else if (p.includes('don lalo 800 ml') || p.includes('donlalo_800ml')) return 'donlalo_800ml';
    else if (p.includes('don lalo balde 20 lt') || p.includes('donlalo_20lt')) return 'donlalo_20lt';
    else if (p.includes('belini 200 ml') || p.includes('belini_200ml')) return 'belini_200ml';
    else if (p.includes('belini 500 ml') || p.includes('belini_500ml')) return 'belini_500ml';
    else if (p.includes('belini 900 ml') || p.includes('belini_900ml')) return 'belini_900ml';
    else if (p.includes('belini 1 lt') || p.includes('belini_1lt')) return 'belini_1lt';
    else if (p.includes('belini 2 lt') || p.includes('belini_2lt')) return 'belini_2lt';
    else if (p.includes('belini 3 lt') || p.includes('belini_3lt')) return 'belini_3lt';
    else if (p.includes('belini 5 lt') || p.includes('belini_5lt')) return 'belini_5lt';
    else if (p.includes('belini lata 18 lt') || p.includes('belini_lata18lt')) return 'belini_lata18lt';
    else if (p.includes('belini balde 18 lt') || p.includes('belini_balde18lt')) return 'belini_balde18lt';
    return '';
}

/**
 * Traduce la presentación elegida en el formulario al producto_key de la receta.
 * Primero usa el catálogo fijo (comportamiento histórico) y, si no está,
 * pregunta a la BD: así un producto creado desde el módulo de Recetas también
 * se puede reportar sin tocar código.
 */
async function resolverProductoKey(presentacion, q = pool) {
    const directo = detectarProductoTipo(presentacion);
    if (directo) return directo;

    const texto = String(presentacion || '').trim();
    if (!texto) return '';

    const r = await q.query(
        `SELECT DISTINCT producto_key FROM recetas
          WHERE nombre_producto ILIKE $1 OR producto_key ILIKE $1
          ORDER BY producto_key LIMIT 1`,
        [texto]
    );
    return r.rows.length ? r.rows[0].producto_key : '';
}

function safeParseJson(str) {
    try {
        return typeof str === 'string' ? JSON.parse(str) : str;
    } catch (e) {
        return null;
    }
}

app.post('/api/produccion/reporte', gProduccion, async (req, res) => {
    try {
        const { fecha_produccion, presentacion, cantidad_cajas, toneladas, observaciones, usuario } = req.body;
        const cajas = Number(cantidad_cajas);

        if (!presentacion || !String(presentacion).trim()) {
            return res.status(400).json({ success: false, mensaje: 'Debe seleccionar la presentación de la producción.' });
        }
        const producto_tipo = await resolverProductoKey(presentacion);
        if (!producto_tipo) {
            return res.status(400).json({ success: false, mensaje: `La presentación "${presentacion}" no tiene receta registrada.` });
        }
        if (!cajas || isNaN(cajas) || cajas <= 0 || cajas > 1000000) {
            return res.status(400).json({ success: false, mensaje: 'Cantidad de cajas inválida. Debe ser un número mayor a 0.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user', $1, true)`, [usuarioResponsable(req, usuario) || 'produccion']);

            // El motor devuelve hojas de inventario ya aplanadas (insumo_id) con
            // merma y stock de seguridad aplicados: no hay segunda búsqueda por
            // texto que pueda fallar o golpear otro artículo con nombre parecido.
            const insumosADescontar = await calcularInsumosProduccion(producto_tipo, cajas, client);
            if (!insumosADescontar || insumosADescontar.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `No existe receta vigente para "${presentacion}". Contacte a producción para registrar la receta desde el módulo de Recetas.` });
            }

            // Un solo SELECT ... FOR UPDATE, ordenado por id: todas las
            // transacciones toman los bloqueos en el mismo orden y no se
            // traban entre sí. Sin esto, dos producciones simultáneas del mismo
            // producto se bloquean mutuamente y una falla.
            const obligatorios = insumosADescontar.filter(i => i.obligatorio !== false)
                .sort((a, b) => a.insumo_id - b.insumo_id);
            const stockPorId = new Map();
            if (obligatorios.length) {
                const st = await client.query(
                    'SELECT id, nombre, stock, unidad_medida, categoria FROM inventario WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
                    [obligatorios.map(i => i.insumo_id)]
                );
                st.rows.forEach(r => stockPorId.set(r.id, r));
            }

            const faltantes = [];
            const faltantesId = [];
            for (const insumo of obligatorios) {
                const fila = stockPorId.get(insumo.insumo_id);
                const stockActual = fila ? Number(fila.stock || 0) : 0;
                if (stockActual < insumo.cantidad) {
                    faltantes.push(`${insumo.nombre}: requiere ${insumo.cantidad} | stock: ${stockActual}`);
                    if (!fila) faltantesId.push(insumo.insumo_id);
                }
            }
            if (faltantesId.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    mensaje: 'La receta apunta a insumos que no existen en inventario. Revisa las líneas de la receta.',
                    errores: faltantes
                });
            }
            if (faltantes.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    mensaje: 'Stock insuficiente. No se registró nada:\n- ' + faltantes.join('\n- ')
                });
            }

            // El desglose guardado incluye el id del insumo: al borrar el reporte
            // se devuelve exactamente lo que se descontó, aunque la receta haya
            // cambiado desde entonces.
            const desglose = obligatorios.map(insumo => {
                const fila = stockPorId.get(insumo.insumo_id);
                return {
                    nombre: insumo.nombre,
                    articulo_id: insumo.insumo_id,
                    cantidad: Number(insumo.cantidad),
                    unidad_medida: insumo.unidad || (fila ? fila.unidad_medida : 'UNIDADES'),
                    categoria: insumo.categoria || (fila ? fila.categoria : '')
                };
            });
            const desgloseJson = JSON.stringify(desglose);

            for (const insumo of obligatorios) {
                const fila = stockPorId.get(insumo.insumo_id);
                const stockAnterior = Number(fila.stock) || 0;
                const desc = await client.query(
                    'UPDATE inventario SET stock = stock - $1 WHERE id = $2 RETURNING stock',
                    [insumo.cantidad, insumo.insumo_id]
                );
                if (desc.rowCount !== 1) {
                    throw new Error(`No se pudo descontar el stock de "${insumo.nombre}".`);
                }
                const stockNuevo = Number(desc.rows[0].stock);
                await actualizarEstadoArticulo(client, insumo.nombre, insumo.insumo_id);
                await registrarHistorial(client, {
                    tipo: 'PRODUCCION', origen: 'envasado',
                    producto: insumo.nombre,
                    articulo_id: insumo.insumo_id,
                    cantidad: Number(insumo.cantidad), tipo_cambio: 'RESTA',
                    stock_anterior: stockAnterior, stock_nuevo: stockNuevo,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Descuento por envasado: ' + cajas + ' cajas de ' + presentacion
                });
            }

            if (producto_tipo) {
                // El nombre legible sale de la receta (que es donde vive para los
                // productos nuevos); el mapa fijo queda como respaldo.
                const nombreLegible = (insumosADescontar[0] && insumosADescontar[0].nombre_producto)
                    || PRODUCTOS_TERMINADOS_MAP[producto_tipo]
                    || presentacion;
                const previo = await client.query('SELECT stock_cajas FROM producto_terminado WHERE producto_key = $1', [producto_tipo]);
                const stockAnteriorPT = previo.rows.length > 0 ? Number(previo.rows[0].stock_cajas) || 0 : 0;
                await client.query(`
                    INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (producto_key) 
                    DO UPDATE SET stock_cajas = producto_terminado.stock_cajas + EXCLUDED.stock_cajas;
                `, [producto_tipo, nombreLegible, cajas]);
                await registrarHistorial(client, {
                    tipo: 'PRODUCCION', origen: 'envasado',
                    producto: nombreLegible,
                    producto_key: producto_tipo,
                    cantidad: cajas, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnteriorPT, stock_nuevo: stockAnteriorPT + cajas,
                    usuario: usuarioResponsable(req, usuario),
                    referencia: 'Producción de ' + cajas + ' cajas - ' + presentacion
                });
            }

            await client.query(
                `INSERT INTO reportes_produccion (fecha_produccion, presentacion, cantidad_cajas, unidad_medida, toneladas, observaciones, usuario_registro, desglose_insumos) 
                 VALUES ($1, $2, $3, 'CAJAS', $4, $5, $6, $7)`,
                [fecha_produccion || new Date(), presentacion, cajas, toneladas, observaciones || '', usuario || 'envasado_user', desgloseJson]
            );

            await client.query('COMMIT');
            res.json({ success: true, mensaje: 'Reporte registrado y stock de insumos/tapas descontado correctamente.' });
        } catch (innerErr) {
            await client.query('ROLLBACK');
            throw innerErr;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error en reporte producción:", err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/produccion/reportes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reportes_produccion ORDER BY id DESC LIMIT 50');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/produccion/informes', async (req, res) => {
    try {
        const { fecha } = req.query;
        let query = 'SELECT * FROM reportes_produccion';
        const params = [];
        if (fecha) {
            query += ' WHERE fecha_produccion = $1';
            params.push(fecha);
        }
        query += ' ORDER BY fecha_produccion DESC, id DESC';
        const result = await pool.query(query, params);

        const informes = result.rows.map(r => ({
            id: r.id,
            fecha_produccion: r.fecha_produccion,
            presentacion: r.presentacion,
            cantidad_cajas: r.cantidad_cajas,
            toneladas: r.toneladas,
            usuario_registro: r.usuario_registro,
            observaciones: r.observaciones,
            desglose: r.desglose_insumos ? safeParseJson(r.desglose_insumos) : null
        }));

        for (const inf of informes) {
            if (!inf.desglose) {
                const tipo = await resolverProductoKey(inf.presentacion);
                if (tipo) {
                    const insumos = await calcularInsumosProduccion(tipo, parseInt(inf.cantidad_cajas, 10) || 0);
                    inf.desglose = insumos.filter(i => i.obligatorio !== false).map(i => ({
                        nombre: i.nombre,
                        articulo_id: i.insumo_id,
                        cantidad: Number(i.cantidad),
                        unidad_medida: i.unidad || 'UNIDADES',
                        categoria: ''
                    }));
                } else {
                    inf.desglose = [];
                }
            }
        }

        res.json(informes);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/produccion/eliminar', gProduccion, async (req, res) => {
    const client = await pool.connect();
    try {
        const { reporte_id } = req.body;
        await client.query('BEGIN');

        const repRes = await client.query('SELECT * FROM reportes_produccion WHERE id = $1', [reporte_id]);
        if (repRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El reporte ya no existe (pudo haber sido cerrado).' });
        }
        const reporte = repRes.rows[0];

        const producto_tipo = await resolverProductoKey(reporte.presentacion, client);
        const cantidad_cajas = parseInt(reporte.cantidad_cajas, 10);

        // Se devuelve con las MISMAS hojas que se descontaron, por id de
        // inventario. Si la receta cambió desde el reporte, el desglose guardado
        // es la fuente de verdad del descuento original, y sigue siendo válido
        // aunque la receta ya no exista o el producto no se pueda resolver.
        let insumosADevolver;
        const guardado = safeParseJson(reporte.desglose_insumos);
        if (Array.isArray(guardado) && guardado.length) {
            const ids = guardado.map(g => g.articulo_id).filter(Boolean);
            const nombres = guardado.map(g => (g.nombre || '').trim()).filter(Boolean);
            const st = ids.length
                ? await client.query('SELECT id, nombre FROM inventario WHERE id = ANY($1::int[])', [ids])
                : { rows: [] };
            const porId = new Map(st.rows.map(r => [r.id, r.nombre]));

            // Reportes anteriores a la migracion guardaban solo el nombre. Se
            // busca el id por nombre normalizado: son ~80 insumos, asi que
            // emparejar en memoria vale mas que traducir la normalizacion a SQL.
            if (nombres.length) {
                const rN = await client.query('SELECT id, nombre FROM inventario');
                rN.rows.forEach(r => porId.set(r.id, r.nombre));
            }

            insumosADevolver = guardado.map(g => ({
                insumo_id: g.articulo_id || null,
                nombre: g.nombre,
                cantidad: Number(g.cantidad) || 0
            })).filter(i => i.cantidad > 0);

            for (const i of insumosADevolver) {
                if (i.insumo_id && porId.has(i.insumo_id)) continue;
                const objetivo = normalizar(i.nombre);
                if (!objetivo) continue;
                for (const [id, nom] of porId.entries()) {
                    if (normalizar(nom) === objetivo) {
                        i.insumo_id = id;
                        break;
                    }
                }
            }

            // Se detectan las lineas sin resolver ANTES de filtrarlas: si se
            // filtraran primero, quedaria una devolucion parcial en la que el
            // reporte se borra y el stock de esas lineas nunca vuelve.
            const sinId = insumosADevolver.filter(i => !i.insumo_id);
            if (sinId.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    mensaje: 'No se puede devolver el reporte: el desglose guardado tiene insumos que ya no existen en inventario. Revisa el reporte manualmente.',
                    detalle: sinId.map(i => i.nombre)
                });
            }
        } else if (producto_tipo) {
            insumosADevolver = (await calcularInsumosProduccion(producto_tipo, cantidad_cajas, client))
                .filter(i => i.obligatorio !== false);
        } else {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                mensaje: 'Este reporte es anterior a la migracion de recetas y no tiene desglose guardado. No se puede devolver el stock automaticamente: revisalo a mano.'
            });
        }

        {
            const ordenados = [...insumosADevolver].sort((a, b) => a.insumo_id - b.insumo_id);
            const stBloqueo = await client.query(
                'SELECT id, nombre, stock FROM inventario WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
                [ordenados.map(i => i.insumo_id)]
            );
            const porIdBloqueado = new Map(stBloqueo.rows.map(r => [r.id, r]));

            for (const insumo of ordenados) {
                const fila = porIdBloqueado.get(insumo.insumo_id);
                if (!fila) {
                    throw new Error(`El insumo "${insumo.nombre}" del reporte ya no existe en inventario.`);
                }
                const stockAnterior = Number(fila.stock) || 0;
                const suma = await client.query(
                    'UPDATE inventario SET stock = stock + $1 WHERE id = $2 RETURNING stock',
                    [insumo.cantidad, insumo.insumo_id]
                );
                if (suma.rowCount !== 1) {
                    throw new Error(`No se pudo devolver el stock de "${insumo.nombre}".`);
                }
                const stockNuevo = Number(suma.rows[0].stock);
                await actualizarEstadoArticulo(client, insumo.nombre, insumo.insumo_id);
                await registrarHistorial(client, {
                    tipo: 'DEVOLUCION', origen: 'envasado',
                    producto: insumo.nombre,
                    articulo_id: insumo.insumo_id,
                    cantidad: Number(insumo.cantidad), tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockNuevo,
                    usuario: usuarioResponsable(req, req.body.usuario),
                    referencia: 'Devolución al eliminar reporte: ' + cantidad_cajas + ' cajas de ' + reporte.presentacion
                });
            }

            // El producto terminado solo se devuelve si el reporte lo descontó.
            if (producto_tipo) {
                const stPT = await client.query('SELECT nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1', [producto_tipo]);
                if (stPT.rows.length > 0) {
                    const stockAnteriorPT = Number(stPT.rows[0].stock_cajas) || 0;
                    await client.query(
                        'UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE producto_key = $2',
                        [cantidad_cajas, producto_tipo]
                    );
                    await registrarHistorial(client, {
                        tipo: 'DEVOLUCION', origen: 'envasado',
                        producto: stPT.rows[0].nombre_producto,
                        producto_key: producto_tipo,
                        cantidad: cantidad_cajas, tipo_cambio: 'RESTA',
                        stock_anterior: stockAnteriorPT, stock_nuevo: stockAnteriorPT - cantidad_cajas,
                        usuario: usuarioResponsable(req, req.body.usuario),
                        referencia: 'Devolución al eliminar reporte de ' + reporte.presentacion
                    });
                }
            }
        }

        await client.query('DELETE FROM reportes_produccion WHERE id = $1', [reporte_id]);

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Reporte de producción eliminado. Insumos devueltos al inventario; ya puedes volver a reportarlo.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error al eliminar reporte:", err);
        res.status(500).json({ success: false, mensaje: 'Error al eliminar el reporte: ' + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/produccion/cierre', gProduccion, async (req, res) => {
    const client = await pool.connect();
    try {
        const { fecha_cierre, usuario } = req.body;
        if (!fecha_cierre || !String(fecha_cierre).trim() || !/^\d{4}-\d{2}-\d{2}/.test(String(fecha_cierre))) {
            return res.status(400).json({ success: false, mensaje: 'Debe indicar una fecha de cierre válida (AAAA-MM-DD).' });
        }
        await client.query('BEGIN');

        const reportesRes = await client.query(
            `SELECT * FROM reportes_produccion WHERE fecha_produccion::text LIKE $1`, 
            [`${fecha_cierre}%`]
        );

        if (reportesRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'No hay producciones activas para cerrar en esta fecha.' });
        }

        let totalCajas = 0;
        let totalTn = 0;
        const itemsDetalle = reportesRes.rows.map(row => {
            totalCajas += parseFloat(row.cantidad_cajas || 0);
            totalTn += parseFloat(row.toneladas || 0);
            return {
                fecha: row.fecha_produccion ? row.fecha_produccion.toISOString().split('T')[0] : fecha_cierre,
                presentacion: row.presentacion,
                cant: row.cantidad_cajas,
                um: row.unidad_medida || 'CAJAS',
                tn: row.toneladas,
                obs: row.observaciones
            };
        });

        await client.query(
            `INSERT INTO historial_cierres_produccion (fecha_cierre, total_cajas, total_toneladas, usuario_cierre, detalle_json) 
             VALUES ($1, $2, $3, $4, $5)`,
            [fecha_cierre, totalCajas, totalTn, usuario || 'envasado_user', JSON.stringify(itemsDetalle)]
        );

        await client.query(`DELETE FROM reportes_produccion WHERE fecha_produccion::text LIKE $1`, [`${fecha_cierre}%`]);

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Cierre de producción realizado con éxito.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error en cierre:", err);
        res.status(500).json({ success: false, mensaje: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/produccion/historial-cierres', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM historial_cierres_produccion ORDER BY fecha_cierre DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- REFINERÍA: REPORTE DIARIO DE CONTROL E INVENTARIO ---
const ROLES_REFINADO = ['auditoria', 'supervisor', 'produccion', 'refinado'];

// enforce: true porque estas rutas ya bloqueaban antes de existir el modo observación.
const requerirRolRefinado = crearGuardRoles(ROLES_REFINADO, { enforce: true });

const INSUMOS_REFINADO_BASE = [
    { nombre: 'ACEITE CRUDO DE SOYA TK-1', um: 'TON' },
    { nombre: 'ACEITE CRUDO DE SOYA TK-2', um: 'TON' },
    { nombre: 'TONSIL OPTIMUN 363', um: 'KG' },
    { nombre: 'TONSIL SUPREME 169', um: 'KG' },
    { nombre: 'ACIDO FOSFORICO', um: 'KG' },
    { nombre: 'SODA EN SOLUCION AL 50%', um: 'KG' },
    { nombre: 'SAL', um: 'KG' },
    { nombre: 'MANGAS FILTRANTES', um: 'UND' },
    { nombre: 'TELA (para filtro prensa)', um: 'UND' }
];

app.get('/api/refinado/reporte', requerirRolRefinado, async (req, res) => {
    try {
        const fecha = String(req.query.fecha || '').trim();
        const turno = String(req.query.turno || 'DIA').trim().toUpperCase();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
            return res.status(400).json({ success: false, mensaje: 'Indique una fecha válida (AAAA-MM-DD).' });
        }
        if (!['DIA', 'NOCHE'].includes(turno)) {
            return res.status(400).json({ success: false, mensaje: 'Turno inválido. Use DIA o NOCHE.' });
        }
        const result = await pool.query('SELECT * FROM reportes_refinado WHERE fecha_reporte = $1 AND turno = $2', [fecha, turno]);
        let reporte = null;
        if (result.rows.length) {
            const r = result.rows[0];
            let lotes = [], totales = null;
            try { lotes = JSON.parse(r.aceite_json); } catch (e) {}
            try { totales = JSON.parse(r.totales_json); } catch (e) {}
            reporte = {
                id: r.id,
                fecha_reporte: r.fecha_reporte,
                turno: r.turno,
                lotes,
                totales,
                observaciones: r.observaciones,
                usuario_registro: r.usuario_registro,
                fecha_registro: r.fecha_registro
            };
        }
        res.json({ success: true, reporte, insumosBase: INSUMOS_REFINADO_BASE });
    } catch (err) {
        console.error('Error GET refinado:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

function ordenarLotes(lotes) {
    return (lotes || []).slice().sort((a, b) => {
        const na = parseInt(String(a.lote).replace(/\D/g, ''), 10) || 0;
        const nb = parseInt(String(b.lote).replace(/\D/g, ''), 10) || 0;
        return na - nb;
    });
}

function sanitizarInsumoLote(it) {
    const nombre = (it && it.nombre !== null && it.nombre !== undefined) ? String(it.nombre).trim() : '';
    const um = (it && it.um !== null && it.um !== undefined) ? String(it.um).trim() : '';
    let cantidad = (it && it.cantidad !== null && it.cantidad !== undefined) ? it.cantidad : null;
    if (cantidad !== null && cantidad !== '') {
        cantidad = Number(cantidad);
        if (isNaN(cantidad) || cantidad < 0) cantidad = null;
    } else {
        cantidad = null;
    }
    return { nombre, cantidad, um };
}

function sanitizarLote(o) {
    o = o || {};
    const tanque = String(o.tanque || 'TK-1').trim().toUpperCase();
    let cantidad = (o.cantidad === null || o.cantidad === undefined || o.cantidad === '') ? null : Number(o.cantidad);
    if (cantidad !== null && (isNaN(cantidad) || cantidad < 0)) cantidad = null;
    return {
        lote: String(o.lote || '').trim(),
        hora: String(o.hora || '').trim().slice(0, 5),
        producto: String(o.producto || 'ACEITE REFINADO DE SOYA').trim(),
        cantidad,
        tanque: (tanque === 'TK-2') ? 'TK-2' : 'TK-1',
        proveedor: (o.proveedor === null || o.proveedor === undefined) ? '' : String(o.proveedor).trim(),
        fecha_produccion: String(o.fecha_produccion || '').trim(),
        estado: String(o.estado || 'DISPONIBLE').trim(),
        insumos: Array.isArray(o.insumos)
            ? o.insumos.map(sanitizarInsumoLote).filter(it => it.nombre && it.cantidad !== null && !isNaN(Number(it.cantidad)) && Number(it.cantidad) > 0)
            : []
    };
}

// Descuenta/restaura un insumo del stock de refinado (Almacén) según el reporte de lotes.
async function aplicarMovimientoStockInsumoRefinado(nombre, cantidad, signo, usuario, referencia) {
    if (!nombre || !(Number(cantidad) > 0)) return;
    const res = await pool.query('SELECT id, nombre, stock FROM stock_insumos_refinado WHERE LOWER(BTRIM(nombre)) = $1', [String(nombre).trim().toLowerCase()]);
    if (!res.rows.length) return;
    const item = res.rows[0];
    const stockAnterior = Number(item.stock) || 0;
    const stockNuevo = Math.max(0, stockAnterior + signo * Number(cantidad));
    await pool.query(
        `UPDATE stock_insumos_refinado SET
             stock = $1::numeric,
             estado = CASE WHEN $1::numeric <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END,
             usuario_ajuste = $2,
             fecha_ajuste = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [stockNuevo, usuario, item.id]
    );
    await registrarHistorial(pool, {
        tipo: signo < 0 ? 'SALIDA' : 'ENTRADA',
        origen: 'refinado',
        producto: item.nombre,
        articulo_id: item.id,
        cantidad: Number(cantidad),
        tipo_cambio: signo < 0 ? 'RESTA' : 'SUMA',
        stock_anterior: stockAnterior,
        stock_nuevo: stockNuevo,
        usuario: usuario,
        referencia: referencia || 'Movimiento por lote de refinado',
        tolerable: true
    });
}

async function aplicarInsumosLoteStock(insumos, signo, usuario, referencia) {
    insumos = Array.isArray(insumos) ? insumos : [];
    for (const it of insumos) {
        const cant = (it && it.cantidad !== null && it.cantidad !== undefined) ? Number(it.cantidad) : 0;
        if ((it && it.nombre) && cant > 0) {
            await aplicarMovimientoStockInsumoRefinado(it.nombre, cant, signo, usuario, referencia);
        }
    }
}

app.post('/api/refinado/guardar', requerirRolRefinado, async (req, res) => {
    try {
        const { fecha_reporte, turno, lote, observaciones, produccion_manana } = req.body || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha_reporte || ''))) {
            return res.status(400).json({ success: false, mensaje: 'Fecha inválida (use AAAA-MM-DD).' });
        }
        const turnoVal = String(turno || 'DIA').trim().toUpperCase();
        if (!['DIA', 'NOCHE'].includes(turnoVal)) {
            return res.status(400).json({ success: false, mensaje: 'Turno inválido. Use DIA o NOCHE.' });
        }
        const sel = await pool.query('SELECT aceite_json, totales_json, observaciones FROM reportes_refinado WHERE fecha_reporte = $1 AND turno = $2', [fecha_reporte, turnoVal]);
        let lotes = [];
        let obs = '';
        let totales = null;
        if (sel.rows.length) {
            try { lotes = JSON.parse(sel.rows[0].aceite_json) || []; } catch (e) {}
            try { totales = JSON.parse(sel.rows[0].totales_json) || null; } catch (e) {}
            obs = sel.rows[0].observaciones || '';
        }
        if (lote && typeof lote === 'object') {
            const limpio = sanitizarLote(lote);
            if (!limpio.lote) {
                return res.status(400).json({ success: false, mensaje: 'Ingrese el número de lote para registrarlo.' });
            }
            const idx = lotes.findIndex(x => String(x.lote || '').trim() === limpio.lote);
            if (idx >= 0) {
                await aplicarInsumosLoteStock(lotes[idx].insumos, 1, req.usuario, 'Restauración por edición del lote ' + limpio.lote);
                lotes[idx] = limpio;
            } else {
                lotes.push(limpio);
            }
            await aplicarInsumosLoteStock(limpio.insumos, -1, req.usuario, 'Descuento por registro del lote de refinado ' + limpio.lote);
            lotes = ordenarLotes(lotes);
        }
        if (observaciones !== undefined && observaciones !== null) obs = String(observaciones);
        let pmNuevo = (produccion_manana === null || produccion_manana === undefined || produccion_manana === '') ? null : Number(produccion_manana);
        if (pmNuevo !== null && isNaN(pmNuevo)) pmNuevo = null;
        const totalesLimpio = {
            produccion_manana: pmNuevo !== null ? pmNuevo : ((totales && totales.produccion_manana) || null),
            total_lotes: lotes.length,
            total_tm: lotes.reduce((sum, a) => sum + (Number(a.cantidad) || 0), 0)
        };

        const result = await pool.query(`
            INSERT INTO reportes_refinado (fecha_reporte, turno, insumos_json, aceite_json, totales_json, observaciones, usuario_registro)
            VALUES ($1, $2, '[]', $3, $4, $5, $6)
            ON CONFLICT (fecha_reporte, turno) DO UPDATE SET
                aceite_json = EXCLUDED.aceite_json,
                totales_json = EXCLUDED.totales_json,
                observaciones = EXCLUDED.observaciones,
                usuario_registro = EXCLUDED.usuario_registro,
                fecha_registro = CURRENT_TIMESTAMP
            RETURNING id`, [
            fecha_reporte, turnoVal, JSON.stringify(lotes), JSON.stringify(totalesLimpio), obs, req.usuario
        ]);

        res.json({ success: true, mensaje: lote && typeof lote === 'object' ? 'Lote guardado correctamente.' : 'Datos del turno guardados correctamente.', id: result.rows[0].id });
    } catch (err) {
        console.error("Error guardar refinado:", err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    }
});

app.post('/api/refinado/lotes/eliminar', requerirRolRefinado, async (req, res) => {
    try {
        const { fecha_reporte, turno, lote } = req.body || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha_reporte || ''))) {
            return res.status(400).json({ success: false, mensaje: 'Fecha inválida (use AAAA-MM-DD).' });
        }
        const turnoVal = String(turno || 'DIA').trim().toUpperCase();
        if (!['DIA', 'NOCHE'].includes(turnoVal)) {
            return res.status(400).json({ success: false, mensaje: 'Turno inválido. Use DIA o NOCHE.' });
        }
        const numLote = String(lote || '').trim();
        if (!numLote) {
            return res.status(400).json({ success: false, mensaje: 'Indique el número de lote a eliminar.' });
        }
        const sel = await pool.query('SELECT aceite_json, totales_json FROM reportes_refinado WHERE fecha_reporte = $1 AND turno = $2', [fecha_reporte, turnoVal]);
        if (!sel.rows.length) {
            return res.json({ success: true, mensaje: 'No hay reporte para el turno indicado.' });
        }
        let lotes = [];
        let totales = null;
        try { lotes = JSON.parse(sel.rows[0].aceite_json) || []; } catch (e) {}
        try { totales = JSON.parse(sel.rows[0].totales_json) || null; } catch (e) {}
        const antes = lotes.length;
        const loteEliminado = lotes.find(x => String(x.lote || '').trim() === numLote);
        lotes = lotes.filter(x => String(x.lote || '').trim() !== numLote);
        if (loteEliminado) {
            await aplicarInsumosLoteStock(loteEliminado.insumos, 1, req.usuario, 'Restauración por eliminación del lote de refinado ' + numLote);
        }
        if (lotes.length === antes) {
            return res.json({ success: true, mensaje: 'El lote no existía en este turno.' });
        }
        const totalesLimpio = {
            produccion_manana: (totales && totales.produccion_manana) || null,
            total_lotes: lotes.length,
            total_tm: lotes.reduce((sum, a) => sum + (Number(a.cantidad) || 0), 0)
        };
        await pool.query(`
            UPDATE reportes_refinado SET
                aceite_json = $1,
                totales_json = $2,
                usuario_registro = $3,
                fecha_registro = CURRENT_TIMESTAMP
            WHERE fecha_reporte = $4 AND turno = $5`, [
            JSON.stringify(lotes), JSON.stringify(totalesLimpio), req.usuario, fecha_reporte, turnoVal
        ]);
        res.json({ success: true, mensaje: 'Lote eliminado correctamente.' });
    } catch (err) {
        console.error("Error eliminar lote refinado:", err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    }
});

// --- ALMACÉN: INVENTARIO (STOCK) DE INSUMOS DE REFINADO ---
const ROLES_ALMACEN_INV_REF = ['admin', 'supervisor', 'almacen', 'auditoria'];
const requerirRolAlmacenInvRef = crearGuardRoles(ROLES_ALMACEN_INV_REF, { enforce: true });

app.get('/api/almacen/stock-refinado', requerirRolAlmacenInvRef, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM stock_insumos_refinado ORDER BY id ASC');
        const baseSinTanques = INSUMOS_REFINADO_BASE.filter(b => b.nombre !== 'ACEITE CRUDO DE SOYA TK-1' && b.nombre !== 'ACEITE CRUDO DE SOYA TK-2');
        res.json({ success: true, insumos: result.rows, insumosBase: baseSinTanques });
    } catch (err) {
        console.error('Error GET stock refinado:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/almacen/stock-refinado/ajustar', requerirRolAlmacenInvRef, async (req, res) => {
    try {
        const { nombre, nuevo_stock } = req.body || {};
        const cantidadNueva = Number(nuevo_stock);
        if (!nombre || isNaN(cantidadNueva)) {
            return res.status(400).json({ success: false, mensaje: 'Indique un insumo válido y que el nuevo stock sea un número.' });
        }
        const actual = await pool.query('SELECT id, nombre, stock FROM stock_insumos_refinado WHERE nombre = $1', [String(nombre)]);
        if (actual.rows.length === 0) {
            return res.status(404).json({ success: false, mensaje: 'El insumo de refinado no existe.' });
        }
        const stockAnterior = Number(actual.rows[0].stock) || 0;
        await pool.query(
            `UPDATE stock_insumos_refinado
             SET stock = $1::numeric,
                 estado = CASE WHEN $1::numeric <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END,
                 usuario_ajuste = $2,
                 fecha_ajuste = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [cantidadNueva, req.usuario, actual.rows[0].id]
        );
        const diferencia = cantidadNueva - stockAnterior;
        await registrarHistorial(pool, {
            tipo: 'AJUSTE',
            origen: 'almacen',
            producto: String(nombre),
            articulo_id: actual.rows[0].id,
            cantidad: Math.abs(diferencia),
            tipo_cambio: diferencia >= 0 ? 'SUMA' : 'RESTA',
            stock_anterior: stockAnterior,
            stock_nuevo: cantidadNueva,
            usuario: usuarioResponsable(req, req.body.usuario),
            referencia: 'Ajuste manual de stock de refinado',
            tolerable: true
        });
        res.json({ success: true, mensaje: 'Stock de insumo de refinado ajustado manualmente.' });
    } catch (err) {
        console.error('Error ajustar stock refinado:', err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    }
});

// ================== BASE DE DATOS GENERAL: PROVEEDORES, OC/OS Y STOCK DE PROVEEDORES ==================
// Base de Datos General. El unico bloque REAL de permisos de todo el modulo:
// enforce:true hace que un rol fuera de esta lista reciba 403 de verdad, no solo
// un aviso en consola. Un rol sin aparecer aqui no puede ni leer proveedores ni
// escribir ordenes, aunque se sepa la URL.
const ROLES_BD_GENERAL = ['admin', 'auditoria', 'consulta_bd'];
const requerirRolBDGeneral = crearGuardRoles(ROLES_BD_GENERAL, { enforce: true });

const CATEGORIAS_PROVEEDOR = ['CAJAS', 'TAPAS Y ACCESORIOS', 'PREFORMAS Y SERVICIOS', 'BOTELLAS Y GALONERAS', 'ETIQUETAS', 'General', 'REFINADO'];
const ESTADOS_ORDEN = ['PENDIENTE', 'EMITIDA', 'RECIBIDA', 'COMPLETADA', 'CANCELADA'];
// IGV de Peru. Va como porcentaje porque cada orden y cada factura pueden traer
// el suyo (un insumo exonerado va en 0).
const IGV_POR_DEFECTO = 18;
const MONEDAS = ['PEN', 'USD'];

// PENDIENTE: registrada, sin acuerdo de pago ni vencimiento.
// CREDITO: el proveedor dio plazo, asi que hay fecha_vencimiento y se puede ver
//   si vencio.
// PAGADA: pagada, con su fecha_pago.
// CANCELADA: la factura es real y la orden si se cubrio a ese precio, pero no se
//   va a cobrar (rechazada, en disputa). Cuenta como facturada y nunca como
//   pagada, asi que queda siempre abierta en el por cobrar de la orden: es el
//   monto que la empresa perdio y tiene que seguir a la vista.
// ANULADA: el documento no existio. No cuenta ni como facturada ni como pagada,
//   y el importe vuelve al por facturar de la orden.
// Que CANCELADA y ANULADA hagan cosas distintas es el punto: si las dos fueran
// "no cuenta", una deuda real que nadie pago quedaria igual que una factura que
// nunca se emitio.
const ESTADOS_FACTURA = ['PENDIENTE', 'CREDITO', 'PAGADA', 'CANCELADA', 'ANULADA'];

// Estados que no aportan nada a la aritmetica de la orden.
const FACTURA_NO_IMPUTABLE = 'ANULADA';

// Fecha de vencimiento: solo tiene sentido en CREDITO. Acepta el string tal
// cual (yyyy-mm-dd) o null, y devuelve null ante cualquier otra cosa para que un
// campo sucio en el formulario termine guardado como NULL en vez de romper la
// columna date.
function normalizarFechaOpcional(valor) {
    const s = String(valor == null ? '' : valor).trim();
    if (!s) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

// Resuelve el par estado/vencimiento de una factura en alta y en edicion.
//
// El vencimiento solo aplica a CREDITO, y en cualquier otro estado se guarda
// NULL en vez de conservar el que traia: los dias puestos en su momento quedan
// obsoletos en cuanto la factura deja de estar a credito, y una fecha vieja
// haria que al volver a CREDITO saltara vencida sin que nadie se acuerde.
//
// Y un credito sin fecha se rechaza en vez de aceptarse. "A credito" sin plazo
// no es un credito, es un pendiente con otra etiqueta, que es justo la confusion
// que estos estados vinieron a eliminar.
function resolverEstadoYVencimiento(estadoCrudo, vencimientoCrudo) {
    const bruto = String(estadoCrudo == null ? '' : estadoCrudo).trim().toUpperCase();
    const estado = ESTADOS_FACTURA.includes(bruto) ? bruto : 'PENDIENTE';
    const vencimiento = normalizarFechaOpcional(vencimientoCrudo);
    if (estado === 'CREDITO' && !vencimiento) {
        return { estado, fechaVencimiento: null, error: 'Una factura a crédito necesita fecha de vencimiento.' };
    }
    return { estado, fechaVencimiento: estado === 'CREDITO' ? vencimiento : null };
}

// Suma de facturas imputables de una orden. Todo lo que calcula el saldo de una
// orden pasa por aca: la regla de que ANULADA no cuenta y PAGADA si esta escrita
// a mano en varias consultas distintas, y con cinco estados en juego, dejarla
// duplicada es la forma facil de que una de ellas se quede vieja y las ordenes
// muestren saldos que se contradicen entre pantallas.
//
// Devuelve el par que necesitan todas las vistas: lo facturado (todo menos
// anuladas) y lo pagado (solo las pagadas), para que por_facturar y por_cobrar
// se deriven de los mismos numeros y no puedan discordar entre endpoints.
function agregadosFacturasDeOrden({ alias = 'f2', ordenId = 'o.id' } = {}) {
    const a = String(alias);
    const id = String(ordenId);
    return {
        facturado: `COALESCE((SELECT SUM(${a}.total) FROM facturas ${a} WHERE ${a}.orden_id = ${id} AND ${a}.estado <> '${FACTURA_NO_IMPUTABLE}'), 0)`,
        pagado: `COALESCE((SELECT SUM(${a}.total) FROM facturas ${a} WHERE ${a}.orden_id = ${id} AND ${a}.estado = 'PAGADA'), 0)`
    };
}

// Los cuatro numeros de la orden en uno. Se usan en el detalle, en la lista y en
// el selector de la pantalla de facturas, para que todos muestren lo mismo.
//
// por_facturar es lo que falta EMITIR (el saldo de antes, renombrado) y
// por_cobrar es lo emitido que todavia no se ha cobrado. Son deudas distintas y
// mezclarlas en un solo numero era justo lo que no permitia ver si lo que se
// debia era plata aun no pedida o plata ya facturada y no pagada.
function resumenPagosOrden(orden) {
    const facturado = redondear2(Number(orden.facturado || 0));
    const pagado = redondear2(Number(orden.pagado || 0));
    return {
        facturado,
        pagado,
        por_facturar: redondear2(Math.max(0, Number(orden.total_igv || 0) - facturado)),
        por_cobrar: redondear2(Math.max(0, facturado - pagado))
    };
}

const TIPOS_COMPROBANTE = ['FACTURA', 'BOLETA', 'NOTA_CREDITO'];

// Estados en los que la cantidad emitida de la orden ya se sumó al stock de proveedores.
const ESTADOS_EMITIDOS = new Set(['EMITIDA', 'RECIBIDA', 'COMPLETADA']);
function esEmitida(o) { return !!(o && ESTADOS_EMITIDOS.has(String(o.estado || ''))); }

// Deja pasar solo monedas de la lista; cualquier otra cae a PEN en vez de
// terminar guardada como texto libre que despues no se puede filtrar.
function normalizarMoneda(valor) {
    const m = String(valor || '').trim().toUpperCase();
    return MONEDAS.includes(m) ? m : 'PEN';
}

// Un filtro de query que no es un entero (un select vacio, un "undefined" que
// el navegador stringifya) no puede llegar a Postgres como NaN: revienta con 500.
// Se traduce a null, que en las consultas significa "sin filtro".
function filtroEnteroQuery(valor) {
    const n = parseInt(valor, 10);
    return Number.isInteger(n) ? n : null;
}

// pg devuelve las columnas date como Date, no como texto. Aplicar String() a un
// Date produce "Thu Oct 01 2026 ..." y al cortar 10 caracteres queda "Thu Oct 01",
// que Postgres rechaza como fecha. Se usan las partes locales del Date, no
// toISOString, que correria el dia en zonas detrras de UTC.
function aFechaSql(valor) {
    if (!valor) return '';
    if (valor instanceof Date) {
        const mes = String(valor.getMonth() + 1).padStart(2, '0');
        const dia = String(valor.getDate()).padStart(2, '0');
        return `${valor.getFullYear()}-${mes}-${dia}`;
    }
    return String(valor).trim().slice(0, 10);
}

async function registrarHistorialStockProveedor(q, datos) {
    try {
        await q.query(
            `INSERT INTO stock_proveedores_historial (tipo, origen, proveedor, producto, unidad, cantidad, orden_ref, guia_ref, usuario)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                datos.tipo || 'SUMA',
                datos.origen || 'OC/OS',
                (datos.proveedor || '').trim(),
                (datos.producto || '').trim(),
                datos.unidad || 'UNIDADES',
                Number(datos.cantidad) || 0,
                datos.orden_ref || null,
                datos.guia_ref || null,
                datos.usuario || 'sistema'
            ]
        );
    } catch (err) {
        console.error("No se pudo registrar en stock_proveedores_historial:", err.message);
    }
}

// Suma (signo=1) o resta (signo=-1) un producto al stock agregado de un proveedor (nunca baja de 0).
async function upsertStockProveedor(q, datos) {
    const proveedor = String(datos.proveedor || '').trim();
    const producto = String(datos.producto || '').trim();
    const cantidad = Number(datos.cantidad);
    if (!proveedor || !producto || !(cantidad > 0)) return;
    const signo = Number(datos.signo) >= 0 ? 1 : -1;
    const unidad = datos.unidad || 'UNIDADES';
    const usuario = datos.usuario || 'sistema';

    const res = await q.query(
        `SELECT id, stock FROM stock_proveedores
         WHERE LOWER(BTRIM(proveedor_nombre)) = LOWER(BTRIM($1)) AND LOWER(BTRIM(producto)) = LOWER(BTRIM($2))`,
        [proveedor, producto]
    );
    let stockAnterior = 0;
    let stockNuevo = 0;
    if (res.rows.length) {
        stockAnterior = Number(res.rows[0].stock) || 0;
        stockNuevo = Math.max(0, stockAnterior + signo * cantidad);
        await q.query(
            `UPDATE stock_proveedores
             SET stock = $1::numeric, unidad = $2, usuario_registro = $3, fecha_actualizacion = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [stockNuevo, unidad, usuario, res.rows[0].id]
        );
    } else {
        stockNuevo = signo < 0 ? 0 : cantidad;
        await q.query(
            `INSERT INTO stock_proveedores (proveedor_nombre, producto, unidad, stock, usuario_registro)
             VALUES ($1, $2, $3, $4, $5)`,
            [proveedor, producto, unidad, stockNuevo, usuario]
        );
    }
    await registrarHistorialStockProveedor(q, {
        tipo: signo < 0 ? 'RESTA' : 'SUMA',
        origen: datos.origen || 'OC/OS',
        proveedor, producto, unidad, cantidad,
        orden_ref: datos.orden_ref, guia_ref: datos.guia_ref, usuario
    });
}

// Aplica el neto emitido de una orden a los ítems del stock de proveedores.
// signo=1 emite (suma cantidad); signo=-1 revierte lo emitido (resta cantidad - recibido).
async function aplicarItemsOrdenStock(q, items, proveedor, signo, usuario, ordenRef) {
    for (const it of items || []) {
        if (it === null || it === undefined) continue;
        let cantidad = Number(it.cantidad) || 0;
        if (signo < 0) {
            cantidad = Math.max(0, cantidad - (Number(it.recibido) || 0));
        }
        if (!it.descripcion || !(cantidad > 0)) continue;
        await upsertStockProveedor(q, {
            proveedor, producto: it.descripcion, unidad: it.unidad || 'UNIDADES',
            cantidad, signo, usuario, orden_ref: ordenRef || null,
            origen: signo < 0 ? 'CANCELACION' : 'EMISION'
        });
    }
}

// Resta automáticamente la cantidad de una guía conformada del stock de proveedores (best-effort por nombre).
async function aplicarGuiaAStockProveedores(q, proveedor, items, numeroGuia, usuario) {
    if (!String(proveedor || '').trim()) return;
    items = Array.isArray(items) ? items : [];
    for (const it of items) {
        const producto = String(it && (it.nombre || it.producto_nombre || it.descripcion) || '').trim();
        const cant = Number(it && it.cantidad_fisica !== null && it.cantidad_fisica !== undefined ? it.cantidad_fisica : (it && it.cantidad)) || 0;
        if (!producto || !(cant > 0)) continue;
        const res = await q.query(
            `SELECT id, stock FROM stock_proveedores
             WHERE LOWER(BTRIM(proveedor_nombre)) = LOWER(BTRIM($1)) AND LOWER(BTRIM(producto)) = LOWER(BTRIM($2))`,
            [String(proveedor).trim(), producto]
        );
        if (!res.rows.length) continue;
        const disponible = Number(res.rows[0].stock) || 0;
        if (disponible <= 0) continue;
        const aRestar = Math.min(disponible, cant);
        const nuevo = disponible - aRestar;
        await q.query('UPDATE stock_proveedores SET stock = $1::numeric, fecha_actualizacion = CURRENT_TIMESTAMP WHERE id = $2', [nuevo, res.rows[0].id]);
        await registrarHistorialStockProveedor(q, {
            tipo: 'RESTA', origen: 'GUIA',
            proveedor: String(proveedor).trim(), producto,
            unidad: it.unidad_medida || it.unidad || 'UNIDADES', cantidad: aRestar,
            orden_ref: null, guia_ref: numeroGuia || null, usuario: usuario || 'sistema'
        });
    }
}

// Redondea a 2 decimales. El IGV se calcula aqui y no llega del cliente: un
// total montado en el navegador no es un dato contable.
function redondear2(valor) {
    return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

// El IGV se deriva del subtotal y del porcentaje, nunca se recibe del cliente.
// Permitir igv_pct en el cuerpo (en vez de fijarlo a 18) es para que un insumo
// exonerado pueda llevar 0. Se acota a 0..100 porque un porcentaje fuera de ahi
// no es un porcentaje de impuesto: colado por un formulario daria un total sin
// sentido, y la base de datos no lo va a rechazar.
function acotarIgvPct(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return IGV_POR_DEFECTO;
    return Math.min(100, Math.max(0, redondear2(n)));
}

/**
 * Los seis campos de entrega que pide el formato de la OC, en el orden en que
 * los consume el INSERT y el UPDATE de la orden.
 *
 * Van como un solo arreglo porque son siempre los mismos cinco en las dos rutas;
 * separarlos en dos listas de strings desalineadas es como un dia de estos
 * acaba escribiendo fecha_entrega en el slot de area_solicitante.
 *
 * @param {object} cuerpo - req.body.
 * @returns {(string|null)[]} lugar, fecha, area, forma de pago, horario, atencion
 */
function camposEntregaDe(cuerpo) {
    const c = cuerpo || {};
    return [
        String(c.lugar_entrega || '').trim() || null,
        String(c.fecha_entrega || '').trim() || null,
        String(c.area_solicitante || '').trim() || null,
        String(c.forma_pago || '').trim() || null,
        String(c.horario_recepcion || '').trim() || null,
        String(c.atencion || '').trim() || null
    ];
}

/**
 * Normaliza las cuentas bancarias que llegan en el cuerpo del proveedor.
 *
 * Sin limite de cantidad: el limite real lo pone el PDF, que no cabe con
 * veinte cuentas en una carta. Se filtra lo que venga incompleto en vez de
 * fallar toda la operacion, porque un formulario con una fila a medio llenar no
 * deberia impedir guardar el nombre y el RUC del proveedor.
 *
 * @param {Array} cuentas
 * @returns {Array<{banco:string,tipo:string,numero:string,moneda:string,titular:string}>}
 */
function normalizarCuentasBancarias(cuentas) {
    return (Array.isArray(cuentas) ? cuentas : [])
        .map(c => ({
            banco: String(c && c.banco ? c.banco : '').trim(),
            tipo: String(c && c.tipo ? c.tipo : '').trim(),
            numero: String(c && c.numero ? c.numero : '').trim(),
            moneda: normalizarMoneda(c && c.moneda),
            titular: String(c && c.titular ? c.titular : '').trim()
        }))
        .filter(c => c.banco && c.numero);
}

/** Reemplaza el conjunto de cuentas bancarias de un proveedor. */
async function reemplazarCuentasBancarias(client, proveedorId, cuentas, usuario) {
    await client.query('DELETE FROM proveedor_cuentas_bancarias WHERE proveedor_id = $1', [proveedorId]);
    let i = 0;
    for (const c of cuentas) {
        await client.query(
            `INSERT INTO proveedor_cuentas_bancarias (proveedor_id, banco, tipo, numero, moneda, titular, orden, usuario_registro)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [proveedorId, c.banco, c.tipo || null, c.numero, c.moneda, c.titular || null, i++, usuario]
        );
    }
}

function normalizarItemsOrden(items, igvPct) {
    const limpios = [];
    let total = 0;
    const pct = acotarIgvPct(igvPct);
    for (const it of Array.isArray(items) ? items : []) {
        const descripcion = String(it && it.descripcion ? it.descripcion : '').trim();
        const cantidad = Number(it && it.cantidad);
        const precio = it && it.precio !== null && it.precio !== undefined && it.precio !== '' ? Number(it.precio) : 0;
        if (!descripcion || !(cantidad > 0) || isNaN(precio)) continue;
        const uni = String(it && it.unidad ? it.unidad : 'UNIDADES').trim().toUpperCase() || 'UNIDADES';
        const subtotal = cantidad * precio;
        total += subtotal;
        limpios.push({
            id: it.id ? parseInt(it.id, 10) : null,
            descripcion, unidad: uni, cantidad, precio, subtotal, recibido: 0
        });
    }
    const igv = redondear2(total * pct / 100);
    return { items: limpios, total: redondear2(total), igv_pct: pct, igv, totalIgv: redondear2(total + igv) };
}

// ---- PROVEEDORES ----
app.get('/api/bd/proveedores', requerirRolBDGeneral, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*,
                (SELECT COUNT(*)::int FROM ordenes_compras_servicios o WHERE o.proveedor_id = p.id AND o.estado <> 'CANCELADA') AS ordenes_activas,
                (SELECT COUNT(*)::int FROM proveedor_cuentas_bancarias cb WHERE cb.proveedor_id = p.id) AS cuentas_bancarias_n
            FROM proveedores p
            ORDER BY LOWER(p.nombre) ASC`);
        const bancos = await pool.query(`
            SELECT proveedor_id, banco, tipo, numero, moneda, titular
            FROM proveedor_cuentas_bancarias ORDER BY proveedor_id, orden, id`);
        // Agrupadas aparte y pegadas por proveedor: el listado es la pantalla que
        // mas veces se abre y no necesita una consulta por fila.
        const porProveedor = new Map();
        for (const c of bancos.rows) {
            if (!porProveedor.has(c.proveedor_id)) porProveedor.set(c.proveedor_id, []);
            porProveedor.get(c.proveedor_id).push({
                banco: c.banco, tipo: c.tipo, numero: c.numero, moneda: c.moneda, titular: c.titular
            });
        }
        res.json({
            success: true,
            proveedores: result.rows.map(p => ({
                ...p,
                cuentas_bancarias: porProveedor.get(p.id) || []
            }))
        });
    } catch (err) {
        console.error('Error GET proveedores:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/bd/proveedores', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const cuerpo = req.body || {};
        const nombre = String(cuerpo.nombre || '').trim();
        if (!nombre) return res.status(400).json({ success: false, mensaje: 'Ingrese el nombre del proveedor.' });
        const categoria = String(cuerpo.categoria || 'General').trim();
        const catFinal = CATEGORIAS_PROVEEDOR.includes(categoria) ? categoria : 'General';
        const cuentas = normalizarCuentasBancarias(cuerpo.cuentas_bancarias);

        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO proveedores (nombre, categoria, ruc, telefono, direccion, email, contacto, usuario_registro)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                nombre, catFinal,
                String(cuerpo.ruc || '').trim(), String(cuerpo.telefono || '').trim(),
                String(cuerpo.direccion || '').trim(), String(cuerpo.email || '').trim(),
                String(cuerpo.contacto || '').trim(), req.usuario
            ]
        );
        await reemplazarCuentasBancarias(client, result.rows[0].id, cuentas, req.usuario);
        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: 'Proveedor registrado correctamente.',
            proveedor: result.rows[0],
            cuentas_bancarias: cuentas
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ya existe un proveedor con ese nombre.' });
        }
        console.error('Error crear proveedor:', err);
        res.status(500).json({ success: false, mensaje: 'Error al crear proveedor: ' + err.message });
    } finally {
        client.release();
    }
});

app.put('/api/bd/proveedores/:id', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de proveedor no válido.' });
        }
        const cuerpo = req.body || {};
        const nombre = String(cuerpo.nombre || '').trim();
        if (!nombre) return res.status(400).json({ success: false, mensaje: 'Ingrese el nombre del proveedor.' });
        const categoria = String(cuerpo.categoria || 'General').trim();
        const catFinal = CATEGORIAS_PROVEEDOR.includes(categoria) ? categoria : 'General';
        // Si el cuerpo no trae el campo, no se tocan las cuentas. Borrarlas
        // porque un cliente no mando un arreglo (una pestana con la pagina
        // vieja, un script, un movil con la sesion a medias) deja al proveedor
        // sin datos para cobrar, y eso no se ve hasta que llega el pago.
        const vieneCuentas = Array.isArray(cuerpo.cuentas_bancarias);
        const cuentas = normalizarCuentasBancarias(cuerpo.cuentas_bancarias);
        await client.query('BEGIN');

        const actual = await client.query('SELECT id, nombre FROM proveedores WHERE id = $1', [id]);
        if (!actual.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El proveedor no existe.' });
        }
        const nombreAntiguo = actual.rows[0].nombre;

        const upd = await client.query(
            `UPDATE proveedores SET nombre = $1, categoria = $2, ruc = $3, telefono = $4, direccion = $5, email = $6, contacto = $7, usuario_registro = $8
             WHERE id = $9 RETURNING *`,
            [
                nombre, catFinal,
                String(cuerpo.ruc || '').trim(), String(cuerpo.telefono || '').trim(),
                String(cuerpo.direccion || '').trim(), String(cuerpo.email || '').trim(),
                String(cuerpo.contacto || '').trim(), req.usuario, id
            ]
        );

        // Mantiene el snapshot de nombre en órdenes y stock si el proveedor se renombra.
        if (nombreAntiguo.toLowerCase().trim() !== nombre.toLowerCase().trim()) {
            await client.query('UPDATE ordenes_compras_servicios SET proveedor_nombre = $1 WHERE proveedor_id = $2', [nombre, id]);
            await client.query(
                `UPDATE stock_proveedores SET proveedor_nombre = $1
                 WHERE LOWER(BTRIM(proveedor_nombre)) = LOWER(BTRIM($2))`,
                [nombre, nombreAntiguo]
            );
        }
        if (vieneCuentas) await reemplazarCuentasBancarias(client, id, cuentas, req.usuario);
        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: 'Proveedor actualizado correctamente.',
            proveedor: upd.rows[0],
            cuentas_bancarias: cuentas
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ya existe un proveedor con ese nombre.' });
        }
        console.error('Error editar proveedor:', err);
        res.status(500).json({ success: false, mensaje: 'Error al editar proveedor: ' + err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/bd/proveedores/:id', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de proveedor no válido.' });
        }
        const ordenes = await pool.query('SELECT COUNT(*)::int AS total FROM ordenes_compras_servicios WHERE proveedor_id = $1', [id]);
        if (ordenes.rows[0].total > 0) {
            return res.status(400).json({ success: false, mensaje: 'No se puede eliminar: el proveedor tiene órdenes registradas.' });
        }
        const stock = await pool.query(`SELECT COUNT(*)::int AS total FROM stock_proveedores WHERE LOWER(BTRIM(proveedor_nombre)) IN (SELECT LOWER(BTRIM(nombre)) FROM proveedores WHERE id = $1)`, [id]);
        if (stock.rows[0].total > 0) {
            return res.status(400).json({ success: false, mensaje: 'No se puede eliminar: el proveedor tiene stock de proveedores acumulado.' });
        }
        await pool.query('DELETE FROM proveedores WHERE id = $1', [id]);
        res.json({ success: true, mensaje: 'Proveedor eliminado correctamente.' });
    } catch (err) {
        console.error('Error eliminar proveedor:', err);
        res.status(500).json({ success: false, mensaje: 'Error al eliminar proveedor: ' + err.message });
    }
});

// ---- ÓRDENES OC/OS ----
app.get('/api/bd/ordenes', requerirRolBDGeneral, async (req, res) => {
    try {
        const tipo = String(req.query.tipo || '').trim();
        const estado = String(req.query.estado || '').trim();
        const proveedorId = req.query.proveedor_id ? parseInt(req.query.proveedor_id, 10) : null;
        // facturado/pagado llegan a la lista para poder filtrar por plata debida
        // sin abrir cada orden. Los dos SUM van en subconsultas gemelas como las
        // demas de la lista; con una tabla de miles de filas la alternativa
        // natural seria un unico GROUP BY, pero a esta escala dos subconsultas
        // correlacionadas sobre el indice de orden_id se comportan mejor y el
        // planner las resuelve en una pasada.
        const agg = agregadosFacturasDeOrden({ alias: 'f', ordenId: 'o.id' });
        const result = await pool.query(`
            SELECT o.*,
                (SELECT COUNT(*)::int FROM ordenes_items it WHERE it.orden_id = o.id) AS n_items,
                COALESCE((SELECT SUM(it.cantidad) FROM ordenes_items it WHERE it.orden_id = o.id), 0) AS total_cantidad,
                COALESCE((SELECT SUM(it.recibido) FROM ordenes_items it WHERE it.orden_id = o.id), 0) AS total_recibido,
                ${agg.facturado} AS facturado,
                ${agg.pagado} AS pagado,
                COALESCE(o.total_igv, 0) - ${agg.facturado} AS por_facturar,
                ${agg.facturado} - ${agg.pagado} AS por_cobrar,
                (SELECT COUNT(*)::int FROM facturas f3
                 WHERE f3.orden_id = o.id AND f3.estado = 'CREDITO'
                   AND f3.fecha_vencimiento IS NOT NULL AND f3.fecha_vencimiento < CURRENT_DATE) AS n_vencidas
            FROM ordenes_compras_servicios o
            WHERE ($1 = '' OR o.tipo = $1)
              AND ($2 = '' OR o.estado = $2)
              AND ($3::int IS NULL OR o.proveedor_id = $3)
            ORDER BY o.id DESC`, [tipo, estado, proveedorId]);
        const ordenes = result.rows.map(o => ({ ...o, ...resumenPagosOrden(o) }));
        res.json({ success: true, ordenes });
    } catch (err) {
        console.error('Error GET ordenes:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/bd/ordenes/:id', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const ordenRes = await pool.query(
            `SELECT o.*, p.nombre AS proveedor_nombre
             FROM ordenes_compras_servicios o
             LEFT JOIN proveedores p ON p.id = o.proveedor_id
             WHERE o.id = $1`, [id]
        );
        if (!ordenRes.rows.length) {
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        const itemsRes = await pool.query('SELECT * FROM ordenes_items WHERE orden_id = $1 ORDER BY id ASC', [id]);
        const movimientosRes = await pool.query(
            `SELECT * FROM stock_proveedores_historial
             WHERE orden_ref = $1 AND origen IN ('EMISION','RECIBIR','CANCELACION')
             ORDER BY id DESC LIMIT 100`, [ordenRes.rows[0].numero]);
        // Las facturas y el resumen de pagos viajan con el detalle para que la
        // pantalla de orden vea que esta facturado y cuanto se cobro, sin una
        // segunda peticion. Las anuladas no cuentan para nada; las canceladas si
        // cuentan como facturadas, porque la orden se cubrio a ese precio aunque
        // ese dinero no se cobre nunca.
        //
        // vencida se resuelve con CURRENT_DATE y no con la fecha del servidor a
        // proposito: el Node puede estar en UTC y en Peru todavia no es el dia
        // siguiente, lo que marcaria como vencida una factura que aun tiene
        // plazo.
        const facturasRes = await pool.query(
            `SELECT *, (estado = 'CREDITO' AND fecha_vencimiento IS NOT NULL
                        AND fecha_vencimiento < CURRENT_DATE) AS vencida
             FROM facturas WHERE orden_id = $1 ORDER BY fecha_factura DESC, id DESC`, [id]
        );
        const facturas = facturasRes.rows;
        const pagos = resumenPagosOrden({
            ...ordenRes.rows[0],
            facturado: facturas
                .filter(f => String(f.estado).toUpperCase() !== FACTURA_NO_IMPUTABLE)
                .reduce((suma, f) => suma + Number(f.total || 0), 0),
            pagado: facturas
                .filter(f => String(f.estado).toUpperCase() === 'PAGADA')
                .reduce((suma, f) => suma + Number(f.total || 0), 0)
        });
        res.json({
            success: true, orden: ordenRes.rows[0], items: itemsRes.rows,
            movimientos: movimientosRes.rows, facturas, ...pagos
        });
    } catch (err) {
        console.error('Error GET orden detalle:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

/**
 * PDF de la orden de compra.
 *
 * Se sirve como descarga (Content-Disposition: attachment) y no se abre en una
 * pestana: el boton del cliente lo pide con fetch y lo baja por blob, porque la
 * autenticacion va solo por header y un window.open() llegaria sin token y se
 * llevaria un 401.
 */
app.get('/api/bd/ordenes/:id/datos-oc', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de orden no válido.' });
        }
        // Reusa el mismo lector que arma el PDF. Es lo que hace que el aviso de
        // "falta esto" sea el mismo que la maqueta: si el formulario contara los
        // huecos por su cuenta, todavia se podrian desalinear.
        const datos = await datosParaOrdenPDF(pool, id);
        if (!datos) {
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        res.json({ success: true, datos: datosFormularioOC(datos) });
    } catch (err) {
        console.error('Error datos OC:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/bd/ordenes/:id/pdf', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de orden no válido.' });
        }
        // POST y no GET porque el formulario que se abre antes de imprimir manda
        // datos que no se guardan en ningun lado: solo existen en este PDF. Por
        // GET no hay donde ponerlos, y meterlos en la query seria meter un
        // arreglo de cuentas bancarias en la URL.
        const cuerpo = req.body || {};
        const datos = await datosParaOrdenPDF(pool, id, {
            entrega: cuerpo.entrega,
            emisor: cuerpo.emisor,
            cuentas: cuerpo.cuentas
        });
        if (!datos) {
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        const buffer = await generarPDFOrdenCompra(datos);
        const nombre = `${datos.orden.tipo === 'OS' ? 'OS' : 'OC'}-${nombreArchivoSeguro(datos.orden.numero, id)}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
        res.end(buffer);
    } catch (err) {
        console.error('Error POST PDF orden:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/bd/ordenes', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const cuerpo = req.body || {};
        const tipo = String(cuerpo.tipo || '').trim().toUpperCase();
        const numero = String(cuerpo.numero || '').trim();
        const estado = ESTADOS_ORDEN.includes(String(cuerpo.estado || '')) ? String(cuerpo.estado).trim() : 'PENDIENTE';
        const proveedorId = parseInt(cuerpo.proveedor_id, 10);
        if (!['OC', 'OS'].includes(tipo)) {
            return res.status(400).json({ success: false, mensaje: 'Tipo de orden inválido (use OC u OS).' });
        }
        if (!numero) {
            return res.status(400).json({ success: false, mensaje: 'Ingrese el número de la orden.' });
        }
        if (!Number.isInteger(proveedorId) || proveedorId <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Seleccione un proveedor.' });
        }
        const fechaOrden = String(cuerpo.fecha_orden || '').trim();

        await client.query('BEGIN');
        const prov = await client.query('SELECT id, nombre FROM proveedores WHERE id = $1', [proveedorId]);
        if (!prov.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El proveedor no existe.' });
        }
        const { items, total, igv, totalIgv } = normalizarItemsOrden(cuerpo.items, cuerpo.igv_pct);
        if (!items.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Agregue al menos un ítem válido con cantidad mayor a 0.' });
        }

        const ins = await client.query(
            `INSERT INTO ordenes_compras_servicios (tipo, numero, fecha_orden, proveedor_id, proveedor_nombre, estado, observaciones, total, moneda, igv_pct, igv, total_igv, usuario_registro, usuario_emision, lugar_entrega, fecha_entrega, area_solicitante, forma_pago, horario_recepcion, atencion)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
            [
                tipo, numero, fechaOrden || null, proveedorId, prov.rows[0].nombre, estado,
                String(cuerpo.observaciones || '').trim(), total,
                normalizarMoneda(cuerpo.moneda), Number.isFinite(Number(cuerpo.igv_pct)) ? Number(cuerpo.igv_pct) : IGV_POR_DEFECTO,
                igv, totalIgv, req.usuario, req.usuario,
                ...camposEntregaDe(cuerpo)
            ]
        );
        for (const it of items) {
            await client.query(
                `INSERT INTO ordenes_items (orden_id, descripcion, unidad, cantidad, precio, subtotal)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [ins.rows[0].id, it.descripcion, it.unidad, it.cantidad, it.precio, it.subtotal]
            );
        }
        if (esEmitida({ estado })) {
            await aplicarItemsOrdenStock(client, items, prov.rows[0].nombre, 1, req.usuario, numero);
        }
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Orden creada correctamente.', id: ins.rows[0].id });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ya existe una orden con ese número para el tipo indicado.' });
        }
        console.error('Error crear orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al crear la orden: ' + err.message });
    } finally {
        client.release();
    }
});

app.put('/api/bd/ordenes/:id', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de orden no válido.' });
        }
        const cuerpo = req.body || {};
        const estadoNuevo = ESTADOS_ORDEN.includes(String(cuerpo.estado || '')) ? String(cuerpo.estado).trim() : 'PENDIENTE';
        const proveedorId = parseInt(cuerpo.proveedor_id, 10);
        const numero = String(cuerpo.numero || '').trim();
        if (!numero) {
            return res.status(400).json({ success: false, mensaje: 'Ingrese el número de la orden.' });
        }
        if (!Number.isInteger(proveedorId) || proveedorId <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Seleccione un proveedor.' });
        }

        await client.query('BEGIN');
        const ordenRes = await client.query('SELECT * FROM ordenes_compras_servicios WHERE id = $1', [id]);
        if (!ordenRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        const vieja = ordenRes.rows[0];
        const prov = await client.query('SELECT id, nombre FROM proveedores WHERE id = $1', [proveedorId]);
        if (!prov.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El proveedor no existe.' });
        }
        const { items, total, igv, totalIgv } = normalizarItemsOrden(cuerpo.items, cuerpo.igv_pct);
        if (!items.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Agregue al menos un ítem válido con cantidad mayor a 0.' });
        }

        const itemsViejos = (await client.query('SELECT * FROM ordenes_items WHERE orden_id = $1', [id])).rows;

        // Revierte el efecto neto de la versión anterior si estaba emitida.
        if (esEmitida(vieja)) {
            await aplicarItemsOrdenStock(client, itemsViejos, vieja.proveedor_nombre || prov.rows[0].nombre, -1, req.usuario, numero);
        }

        const numeroAnterior = vieja.numero;
        await client.query(
            `UPDATE ordenes_compras_servicios SET tipo = $1, numero = $2, fecha_orden = $3, proveedor_id = $4, proveedor_nombre = $5, estado = $6, observaciones = $7, total = $8, moneda = $9, igv_pct = $10, igv = $11, total_igv = $12, usuario_registro = $13,
             lugar_entrega = $14, fecha_entrega = $15, area_solicitante = $16, forma_pago = $17, horario_recepcion = $18, atencion = $19
             WHERE id = $20`,
            [
                String(cuerpo.tipo || '').trim().toUpperCase(), numero,
                String(cuerpo.fecha_orden || '').trim() || null,
                proveedorId, prov.rows[0].nombre, estadoNuevo,
                String(cuerpo.observaciones || '').trim(), total,
                normalizarMoneda(cuerpo.moneda), Number.isFinite(Number(cuerpo.igv_pct)) ? Number(cuerpo.igv_pct) : IGV_POR_DEFECTO,
                igv, totalIgv, req.usuario,
                ...camposEntregaDe(cuerpo), id
            ]
        );

        // Impacta los ítems: conserva el "recibido" de los que ya existían.
        const mapViejos = new Map(itemsViejos.map(it => [it.id, it]));
        const idsNuevos = [];
        for (const it of items) {
            if (it.id && mapViejos.has(it.id)) {
                const prev = mapViejos.get(it.id);
                const rec = Number(prev.recibido) || 0;
                await client.query(
                    `UPDATE ordenes_items SET descripcion = $1, unidad = $2, cantidad = $3, precio = $4, subtotal = $5
                     WHERE id = $6`,
                    [it.descripcion, it.unidad, it.cantidad, it.precio, it.subtotal, it.id]
                );
                it.recibido = rec;
                idsNuevos.push(it.id);
            } else {
                const ins = await client.query(
                    `INSERT INTO ordenes_items (orden_id, descripcion, unidad, cantidad, precio, subtotal)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                    [id, it.descripcion, it.unidad, it.cantidad, it.precio, it.subtotal]
                );
                idsNuevos.push(ins.rows[0].id);
            }
        }
        // Elimina ítems que dejaron de estar en la orden.
        for (const prev of itemsViejos) {
            if (!idsNuevos.includes(prev.id)) {
                await client.query('DELETE FROM ordenes_items WHERE id = $1', [prev.id]);
            }
        }

        if (esEmitida({ estado: estadoNuevo })) {
            await aplicarItemsOrdenStock(client, items, prov.rows[0].nombre, 1, req.usuario, numero);
        }
        if (numeroAnterior && numeroAnterior !== numero) {
            await client.query(
                `UPDATE stock_proveedores_historial SET orden_ref = $1 WHERE orden_ref = $2 AND origen IN ('EMISION','RECIBIR','CANCELACION')`,
                [numero, numeroAnterior]);
        }
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Orden actualizada correctamente.' });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ya existe una orden con ese número para el tipo indicado.' });
        }
        console.error('Error editar orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al editar la orden: ' + err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/bd/ordenes/:id', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de orden no válido.' });
        }
        await client.query('BEGIN');
        // El nombre del proveedor viene por join: la orden guarda el id, y al
        // restaurar el stock despues hay que escribir un texto en el historial.
        const ordenRes = await client.query(
            `SELECT o.*, p.nombre AS proveedor_nombre
             FROM ordenes_compras_servicios o
             LEFT JOIN proveedores p ON p.id = o.proveedor_id
             WHERE o.id = $1`, [id]
        );
        if (!ordenRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        const orden = ordenRes.rows[0];
        // Una factura tiene ON DELETE RESTRICT, asi que sin esta comprobacion el
        // borrado fallaria con un error de constraint que no le dice nada al
        // usuario. Se comprueba antes y se explica.
        const facturas = await client.query(

            'SELECT COUNT(*)::int AS n FROM facturas WHERE orden_id = $1', [id]
        );
        if (facturas.rows[0].n > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                mensaje: `No se puede eliminar: la orden tiene ${facturas.rows[0].n} factura(s) registrada(s). Anule o elimine primero las facturas.`
            });
        }
        if (esEmitida(orden)) {
            const itemsViejos = (await client.query('SELECT * FROM ordenes_items WHERE orden_id = $1', [id])).rows;
            await aplicarItemsOrdenStock(client, itemsViejos, orden.proveedor_nombre || 'N/D', -1, req.usuario, orden.numero);
        }
        await client.query('DELETE FROM ordenes_compras_servicios WHERE id = $1', [id]);
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Orden eliminada correctamente (stock de proveedores restaurado).' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error eliminar orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al eliminar la orden: ' + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/bd/ordenes/:id/estado', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        const estado = String(req.body && req.body.estado || '').trim();
        if (!Number.isInteger(id) || id <= 0 || !ESTADOS_ORDEN.includes(estado)) {
            return res.status(400).json({ success: false, mensaje: 'Estado u orden no válidos.' });
        }
        await client.query('BEGIN');
        const ordenRes = await client.query('SELECT * FROM ordenes_compras_servicios WHERE id = $1', [id]);
        if (!ordenRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        const orden = ordenRes.rows[0];
        const viejaEmitida = esEmitida(orden);
        const nuevaEmitida = esEmitida({ estado }) && (estado !== 'CANCELADA');

        if (estado === 'CANCELADA' && viejaEmitida) {
            const itemsViejos = (await client.query('SELECT * FROM ordenes_items WHERE orden_id = $1', [id])).rows;
            await aplicarItemsOrdenStock(client, itemsViejos, orden.proveedor_nombre || 'N/D', -1, req.usuario, orden.numero);
        } else if (!viejaEmitida && nuevaEmitida) {
            const items = (await client.query('SELECT * FROM ordenes_items WHERE orden_id = $1', [id])).rows;
            await aplicarItemsOrdenStock(client, items, orden.proveedor_nombre || 'N/D', 1, req.usuario, orden.numero);
        }

        await client.query('UPDATE ordenes_compras_servicios SET estado = $1, usuario_registro = $2 WHERE id = $3', [estado, req.usuario, id]);
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Estado de la orden actualizado correctamente.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error estado orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al actualizar el estado: ' + err.message });
    } finally {
        client.release();
    }
});

// Recibe (parcial o total) una cantidad de los ítems de una orden y resta del stock de proveedores.
app.post('/api/bd/ordenes/:id/recibir', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        const cuerpo = req.body || {};
        const numeroGuia = String(cuerpo.numero_guia || '').trim();
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de orden no válido.' });
        }
        await client.query('BEGIN');
        const ordenRes = await client.query('SELECT * FROM ordenes_compras_servicios WHERE id = $1', [id]);
        if (!ordenRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        const orden = ordenRes.rows[0];
        if (String(orden.estado) === 'CANCELADA') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'No se puede recibir una orden cancelada.' });
        }
        const recibidos = Array.isArray(cuerpo.items) ? cuerpo.items : [];
        const itemsDeOrden = (await client.query('SELECT * FROM ordenes_items WHERE orden_id = $1', [id])).rows;

        // Si la orden aún está PENDIENTE y se recibe, primero se emite (suma) y luego se resta lo recibido.
        if (String(orden.estado) === 'PENDIENTE') {
            await aplicarItemsOrdenStock(client, itemsDeOrden, orden.proveedor_nombre || 'N/D', 1, req.usuario, orden.numero);
        }

        let huboRecepcion = false;
        for (const sol of recibidos) {
            const itemId = parseInt(sol && sol.item_id, 10);
            const cant = Number(sol && sol.cantidad_recibida);
            if (!itemId || !(cant > 0)) continue;
            const item = itemsDeOrden.find(x => x.id === itemId);
            if (!item) continue;
            const pendiente = (Number(item.cantidad) || 0) - (Number(item.recibido) || 0);
            if (pendiente <= 0) continue;
            const cantAplicada = Math.min(pendiente, cant);
            const nuevoRecibido = (Number(item.recibido) || 0) + cantAplicada;
            await client.query('UPDATE ordenes_items SET recibido = $1::numeric WHERE id = $2', [nuevoRecibido, itemId]);
            await upsertStockProveedor(client, {
                proveedor: orden.proveedor_nombre || 'N/D', producto: item.descripcion,
                unidad: item.unidad || 'UNIDADES', cantidad: cantAplicada, signo: -1,
                usuario: req.usuario, orden_ref: orden.numero,
                origen: 'RECIBIR', guia_ref: numeroGuia || null
            });
            huboRecepcion = true;
        }

        if (!huboRecepcion) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Indique una cantidad válida a recibir para al menos un ítem.' });
        }

        const itemsActualizados = (await client.query('SELECT * FROM ordenes_items WHERE orden_id = $1', [id])).rows;
        const todosRecibidos = itemsActualizados.every(x => (Number(x.recibido) || 0) >= (Number(x.cantidad) || 0));
        const algunRecibido = itemsActualizados.some(x => (Number(x.recibido) || 0) > 0);
        let estadoNuevo = orden.estado;
        if (String(orden.estado) === 'PENDIENTE' && algunRecibido) estadoNuevo = 'RECIBIDA';
        else if (todosRecibidos) estadoNuevo = 'COMPLETADA';
        else if (algunRecibido) estadoNuevo = 'RECIBIDA';
        if (estadoNuevo !== orden.estado) {
            await client.query('UPDATE ordenes_compras_servicios SET estado = $1 WHERE id = $2', [estadoNuevo, id]);
        }
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Recepción registrada. Stock de proveedores actualizado.', estado: estadoNuevo });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error recibir orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar la recepción: ' + err.message });
    } finally {
        client.release();
    }
});

// ---- PRECIOS POR PROVEEDOR ----
app.get('/api/bd/precios', requerirRolBDGeneral, async (req, res) => {
    try {
        const proveedorId = req.query.proveedor_id ? parseInt(req.query.proveedor_id, 10) : null;
        const moneda = String(req.query.moneda || '').trim().toUpperCase();
        const busqueda = String(req.query.producto || '').trim();
        const result = await pool.query(`
            SELECT pp.*, p.nombre AS proveedor_nombre, p.categoria AS proveedor_categoria,
                (SELECT MAX(h.fecha_cambio) FROM precios_proveedor_historial h WHERE h.precio_id = pp.id) AS ultimo_cambio
            FROM precios_proveedor pp
            JOIN proveedores p ON p.id = pp.proveedor_id
            WHERE ($1::int IS NULL OR pp.proveedor_id = $1)
              AND ($2 = '' OR pp.moneda = $2)
              AND ($3 = '' OR LOWER(pp.producto) LIKE '%' || LOWER($3) || '%')
            ORDER BY LOWER(p.nombre) ASC, LOWER(pp.producto) ASC`, [proveedorId, moneda, busqueda]);
        res.json({ success: true, precios: result.rows });
    } catch (err) {
        console.error('Error GET precios:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/bd/precios', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const cuerpo = req.body || {};
        const proveedorId = parseInt(cuerpo.proveedor_id, 10);
        const producto = String(cuerpo.producto || '').trim();
        const unidad = String(cuerpo.unidad || 'UNIDADES').trim().toUpperCase() || 'UNIDADES';
        const precio = Number(cuerpo.precio);
        if (!Number.isInteger(proveedorId) || proveedorId <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Seleccione un proveedor.' });
        }
        if (!producto) {
            return res.status(400).json({ success: false, mensaje: 'Ingrese el producto.' });
        }
        if (!Number.isFinite(precio) || precio < 0) {
            return res.status(400).json({ success: false, mensaje: 'El precio debe ser un número mayor o igual a 0.' });
        }

        await client.query('BEGIN');
        const prov = await client.query('SELECT id, nombre FROM proveedores WHERE id = $1', [proveedorId]);
        if (!prov.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El proveedor no existe.' });
        }
        const ins = await client.query(
            `INSERT INTO precios_proveedor (proveedor_id, producto, unidad, precio, moneda, usuario_registro)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [proveedorId, producto, unidad, precio, normalizarMoneda(cuerpo.moneda), req.usuario]
        );
        // Alta inicial: el historial arranca en 0 para que la primera variacion
        // sea siempre contra un precio existente y no contra un hueco.
        await client.query(
            `INSERT INTO precios_proveedor_historial
                (precio_id, proveedor_id, proveedor_nombre, producto, unidad, moneda, precio_anterior, precio_nuevo, usuario_cambio)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`,
            [ins.rows[0].id, proveedorId, prov.rows[0].nombre, producto, unidad, ins.rows[0].moneda, precio, req.usuario]
        );
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Precio registrado correctamente.', precio: ins.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ese proveedor ya tiene un precio para ese producto y unidad. Edítelo en lugar de agregarlo de nuevo.' });
        }
        console.error('Error crear precio:', err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar el precio: ' + err.message });
    } finally {
        client.release();
    }
});

app.put('/api/bd/precios/:id', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de precio no válido.' });
        }
        const cuerpo = req.body || {};
        const producto = String(cuerpo.producto || '').trim();
        const unidad = String(cuerpo.unidad || 'UNIDADES').trim().toUpperCase() || 'UNIDADES';
        const precio = Number(cuerpo.precio);
        if (!producto) {
            return res.status(400).json({ success: false, mensaje: 'Ingrese el producto.' });
        }
        if (!Number.isFinite(precio) || precio < 0) {
            return res.status(400).json({ success: false, mensaje: 'El precio debe ser un número mayor o igual a 0.' });
        }

        await client.query('BEGIN');
        // El nombre del proveedor se trae con join: precios_proveedor guarda el id,
        // y el historial lo copia como texto para poder mostrarlo aunque el precio
        // o el proveedor se den de baja despues.
        const actual = await client.query(
            `SELECT pp.*, pr.nombre AS proveedor_nombre
             FROM precios_proveedor pp
             LEFT JOIN proveedores pr ON pr.id = pp.proveedor_id
             WHERE pp.id = $1`, [id]
        );
        if (!actual.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El precio no existe.' });
        }
        const previo = actual.rows[0];
        const upd = await client.query(
            `UPDATE precios_proveedor SET producto = $1, unidad = $2, precio = $3, moneda = $4, usuario_registro = $5
             WHERE id = $6 RETURNING *`,
            [producto, unidad, precio, normalizarMoneda(cuerpo.moneda), req.usuario, id]
        );
        // El registro del historial va en la misma transaccion que el update: si
        // el precio cambia y el historial falla, no cambia ninguno de los dos.
        await client.query(
            `INSERT INTO precios_proveedor_historial
                (precio_id, proveedor_id, proveedor_nombre, producto, unidad, moneda, precio_anterior, precio_nuevo, usuario_cambio)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                id, previo.proveedor_id, previo.proveedor_nombre, producto, unidad, upd.rows[0].moneda,
                Number(previo.precio) || 0, precio, req.usuario
            ]
        );
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Precio actualizado correctamente.', precio: upd.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ese proveedor ya tiene un precio para ese producto y unidad.' });
        }
        console.error('Error editar precio:', err);
        res.status(500).json({ success: false, mensaje: 'Error al actualizar el precio: ' + err.message });
    } finally {
        client.release();
    }
});

// El historial se va con el precio: es el rastro de ese precio, no un log
// suelto. Por eso el ON DELETE CASCADE de la FK.
app.delete('/api/bd/precios/:id', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de precio no válido.' });
        }
        const del = await pool.query('DELETE FROM precios_proveedor WHERE id = $1 RETURNING producto', [id]);
        if (!del.rows.length) {
            return res.status(404).json({ success: false, mensaje: 'El precio no existe.' });
        }
        res.json({ success: true, mensaje: 'Precio eliminado.' });
    } catch (err) {
        console.error('Error eliminar precio:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Filtra por proveedor_id de la propia fila del historial, no por el del precio
// vigente: si el precio se dio de baja el join vendria null y el historico de
// ese proveedor desapareceria del filtro, justo lo que se vino a consultar.
app.get('/api/bd/precios/historial', requerirRolBDGeneral, async (req, res) => {
    try {
        // Un filtro no numerico (por ejemplo un select vacio que el navegador
        // manda como proveedor_id=undefined) no puede mandarse a Postgres como
        // NaN: revienta el endpoint con 500. Se descarta y se lista todo.
        const proveedorId = filtroEnteroQuery(req.query.proveedor_id);
        const result = await pool.query(`
            SELECT h.*
            FROM precios_proveedor_historial h
            WHERE ($1::int IS NULL OR h.proveedor_id = $1)
            ORDER BY h.fecha_cambio DESC, h.id DESC
            LIMIT 300`, [proveedorId]);
        res.json({ success: true, historial: result.rows });
    } catch (err) {
        console.error('Error GET historial precios:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// ---- FACTURAS DE OC / OS ----
app.get('/api/bd/facturas', requerirRolBDGeneral, async (req, res) => {
    try {
        // Igual que en el historial: un filtro no numerico se descarta en vez de
        // llegar a Postgres como NaN.
        const ordenId = filtroEnteroQuery(req.query.orden_id);
        const proveedorId = filtroEnteroQuery(req.query.proveedor_id);
        const estado = String(req.query.estado || '').trim().toUpperCase();
        const agg = agregadosFacturasDeOrden({ alias: 'f2', ordenId: 'f.orden_id' });
        const result = await pool.query(`

            SELECT f.*, o.tipo AS orden_tipo, o.numero AS orden_numero,
                o.total_igv AS orden_total_igv, o.moneda AS orden_moneda,
                ${agg.facturado} AS orden_facturado,
                ${agg.pagado} AS orden_pagado,
                COALESCE(o.total_igv, 0) - ${agg.facturado} AS orden_por_facturar,
                ${agg.facturado} - ${agg.pagado} AS orden_por_cobrar,
                (f.estado = 'CREDITO' AND f.fecha_vencimiento IS NOT NULL
                    AND f.fecha_vencimiento < CURRENT_DATE) AS vencida
            FROM facturas f
            JOIN ordenes_compras_servicios o ON o.id = f.orden_id
            WHERE ($1::int IS NULL OR f.orden_id = $1)
              AND ($2::int IS NULL OR f.proveedor_id = $2)
              AND ($3 = '' OR f.estado = $3)
            ORDER BY f.fecha_factura DESC, f.id DESC
            LIMIT 500`, [ordenId, proveedorId, estado]);
        res.json({ success: true, facturas: result.rows });
    } catch (err) {
        console.error('Error GET facturas:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Totales por estado y moneda. Agrupar por moneda es obligatorio: sumar soles y
// dolares en una misma cifra daria un numero sin sentido.
//
// vencidas no es un estado sino una condicion de tiempo sobre las de credito, y
// se reporta aparte para no mezclarlo con los totales por estado.
app.get('/api/bd/facturas/resumen', requerirRolBDGeneral, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT moneda, estado,
                COUNT(*)::int AS cantidad,
                COALESCE(SUM(subtotal), 0) AS subtotal,
                COALESCE(SUM(igv), 0) AS igv,
                COALESCE(SUM(total), 0) AS total
            FROM facturas
            GROUP BY moneda, estado
            ORDER BY moneda ASC, estado ASC`, []);
        const vencidasRes = await pool.query(`
            SELECT moneda, COUNT(*)::int AS cantidad, COALESCE(SUM(total), 0) AS total
            FROM facturas
            WHERE estado = 'CREDITO' AND fecha_vencimiento IS NOT NULL
              AND fecha_vencimiento < CURRENT_DATE
            GROUP BY moneda`, []);
        res.json({ success: true, resumen: result.rows, vencidas: vencidasRes.rows });
    } catch (err) {
        console.error('Error GET resumen facturas:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Ordenes con su resumen de pagos, para el selector. El filtro 'pendiente' deja
// pasar solo las que aun no estan facturadas por completo; 'facturadas' solo las
// que ya lo estan.
app.get('/api/bd/facturas/ordenes', requerirRolBDGeneral, async (req, res) => {
    try {
        const proveedorId = filtroEnteroQuery(req.query.proveedor_id);
        const filtro = String(req.query.filtro || 'todas').trim().toLowerCase();
        const agg = agregadosFacturasDeOrden({ alias: 'f', ordenId: 'o.id' });
        const result = await pool.query(`
            SELECT o.id, o.tipo, o.numero, o.fecha_orden, o.estado, o.moneda, o.total, o.igv, o.total_igv,
                o.proveedor_id,
                p.nombre AS proveedor_nombre,
                ${agg.facturado} AS facturado,
                ${agg.pagado} AS pagado,
                COALESCE(o.total_igv, 0) - ${agg.facturado} AS por_facturar,
                ${agg.facturado} - ${agg.pagado} AS por_cobrar
            FROM ordenes_compras_servicios o
            LEFT JOIN proveedores p ON p.id = o.proveedor_id
            WHERE ($1::int IS NULL OR o.proveedor_id = $1)
              AND o.estado <> 'CANCELADA'
              AND (
                ($2 = 'pendiente' AND COALESCE(o.total_igv, 0) - ${agg.facturado} > 0.01)
                OR ($2 = 'facturadas' AND ${agg.facturado} > 0)
                OR $2 = 'todas'
              )
            ORDER BY o.id DESC`, [proveedorId, filtro]);
        res.json({ success: true, ordenes: result.rows });
    } catch (err) {
        console.error('Error GET ordenes facturables:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/bd/facturas/:id', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de factura no válido.' });
        }
        const result = await pool.query(`
            SELECT f.*, o.tipo AS orden_tipo, o.numero AS orden_numero
            FROM facturas f
            JOIN ordenes_compras_servicios o ON o.id = f.orden_id
            WHERE f.id = $1`, [id]);
        if (!result.rows.length) {
            return res.status(404).json({ success: false, mensaje: 'La factura no existe.' });
        }
        res.json({ success: true, factura: result.rows[0] });
    } catch (err) {
        console.error('Error GET factura:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/bd/facturas', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const cuerpo = req.body || {};
        const tipoComprobante = TIPOS_COMPROBANTE.includes(String(cuerpo.tipo_comprobante || '').trim().toUpperCase())
            ? String(cuerpo.tipo_comprobante).trim().toUpperCase() : 'FACTURA';
        const serie = String(cuerpo.serie || '').trim().toUpperCase();
        const numero = String(cuerpo.numero || '').trim();
        const ordenId = parseInt(cuerpo.orden_id, 10);
        const subtotal = Number(cuerpo.subtotal);
        const estadoRes = resolverEstadoYVencimiento(cuerpo.estado, cuerpo.fecha_vencimiento);
        const estado = estadoRes.estado;

        if (estadoRes.error) {
            return res.status(400).json({ success: false, mensaje: estadoRes.error });
        }
        if (!serie || !numero) {
            return res.status(400).json({ success: false, mensaje: 'Ingrese la serie y el número del comprobante.' });
        }
        if (!Number.isInteger(ordenId) || ordenId <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Seleccione la orden a facturar.' });
        }
        if (!Number.isFinite(subtotal) || subtotal < 0) {
            return res.status(400).json({ success: false, mensaje: 'El subtotal debe ser un número mayor o igual a 0.' });
        }
        const fechaFactura = String(cuerpo.fecha_factura || '').trim();

        await client.query('BEGIN');
        // El nombre del proveedor viene por join: la orden guarda el id, no el
        // texto. La factura lo copia para poder mostrarlo aunque el proveedor se
        // de de baja despues.
        const orden = await client.query(
            `SELECT o.*, p.nombre AS proveedor_nombre
             FROM ordenes_compras_servicios o
             LEFT JOIN proveedores p ON p.id = o.proveedor_id
             WHERE o.id = $1`, [ordenId]
        );
        if (!orden.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La orden no existe.' });
        }
        // El proveedor lo toma la orden, no el cuerpo: es la orden la que sabe a
        // quien se compro. Aceptarlo del cliente permitiria colgar una factura de
        // un proveedor que no es el de la orden.
        // El IGV se calcula aqui desde el subtotal y el porcentaje. El cliente no
        // puede fijar el total: si lo hiciera, el saldo de la orden dejaria de
        // cuadrar contra lo facturado.
        const igvPct = acotarIgvPct(cuerpo.igv_pct);
        const igv = redondear2(subtotal * igvPct / 100);
        const total = redondear2(subtotal + igv);
        // fecha_factura es NOT NULL en la tabla: si no viene, se fecha hoy en vez
        // de mandar null y dejar que la base rechace la factura entera.
        const fechaDefecto = new Date().toISOString().slice(0, 10);

        const ins = await client.query(
            `INSERT INTO facturas
                (tipo_comprobante, serie, numero, fecha_factura, orden_id, proveedor_id, proveedor_nombre,
                 moneda, igv_pct, subtotal, igv, total, estado, fecha_pago, fecha_vencimiento, observaciones, usuario_registro)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             RETURNING *`,
            [
                tipoComprobante, serie, numero, fechaFactura || fechaDefecto, ordenId,
                orden.rows[0].proveedor_id, orden.rows[0].proveedor_nombre,
                normalizarMoneda(cuerpo.moneda || orden.rows[0].moneda), igvPct,
                redondear2(subtotal), igv, total, estado,
                String(cuerpo.fecha_pago || '').trim() || null,
                estadoRes.fechaVencimiento,
                String(cuerpo.observaciones || '').trim(), req.usuario
            ]
        );
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Factura registrada correctamente.', factura: ins.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ya existe una factura con ese tipo, serie y número.' });
        }
        if (err.code === '23503') {
            return res.status(400).json({ success: false, mensaje: 'La factura no pudo vincularse a la orden indicada.' });
        }
        console.error('Error crear factura:', err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar la factura: ' + err.message });
    } finally {
        client.release();
    }
});

app.put('/api/bd/facturas/:id', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de factura no válido.' });
        }
        const cuerpo = req.body || {};
        const numero = String(cuerpo.numero || '').trim();
        const subtotal = Number(cuerpo.subtotal);
        if (!numero) {
            return res.status(400).json({ success: false, mensaje: 'Ingrese el número del comprobante.' });
        }
        if (!Number.isFinite(subtotal) || subtotal < 0) {
            return res.status(400).json({ success: false, mensaje: 'El subtotal debe ser un número mayor o igual a 0.' });
        }
        const estadoPedido = String(cuerpo.estado == null ? '' : cuerpo.estado).trim().toUpperCase();

        // Editar es cambiar una cosa ya registrada, asi que un estado invalido se
        // rechaza en vez de caerse a PENDIENTE por la puerta de atras: asi una
        // factura que el usuario dio por pagada ayer no finishes guardada como
        // pendiente por un typo.
        if (estadoPedido && !ESTADOS_FACTURA.includes(estadoPedido)) {
            return res.status(400).json({ success: false, mensaje: 'El estado de la factura no es válido.' });
        }

        await client.query('BEGIN');
        const actual = await client.query('SELECT * FROM facturas WHERE id = $1', [id]);
        if (!actual.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La factura no existe.' });
        }
        // Si el cliente no manda estado, se conserva el que ya tenia. Solo si lo
        // manda explicito se reemplaza.
        const estadoFinal = estadoPedido || String(actual.rows[0].estado || 'PENDIENTE').toUpperCase();

        // El vencimiento llega ya resuelto si el cliente lo mando. Si no lo mando
        // (undefined), se conserva el que ya estaba, porque una edicion del numero
        // o del subtotal no deberia obligar a volver a elegir la fecha de plazo.
        // Y si lo mando en blanco, es una peticion explicita de dejarlo sin fecha.
        const envioVencimiento = cuerpo.fecha_vencimiento !== undefined;
        const vencimientoEnviado = envioVencimiento
            ? normalizarFechaOpcional(cuerpo.fecha_vencimiento)
            : normalizarFechaOpcional(actual.rows[0].fecha_vencimiento);
        const fechaVenc = estadoFinal === 'CREDITO' ? vencimientoEnviado : null;
        // A credito sin plazo no es un credito, es un pendiente con otra
        // etiqueta. Se valida despues de leer la fila y no antes, para poder
        // distinguir "no mande la fecha" de "no hay fecha que guardar".
        if (estadoFinal === 'CREDITO' && !fechaVenc) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Una factura a crédito necesita fecha de vencimiento.' });
        }
        // El tipo forma parte de la llave unica del comprobante, asi que si la
        // pantalla lo manda hay que guardarlo: si no, la fila quedaria con un tipo
        // distinto del que se ve en pantalla y del que protege el indice unico.
        const tipoPedido = String(cuerpo.tipo_comprobante || '').trim().toUpperCase();
        const tipoComprobante = TIPOS_COMPROBANTE.includes(tipoPedido)
            ? tipoPedido
            : String(actual.rows[0].tipo_comprobante || 'FACTURA');
        // Cambiar subtotal o porcentaje recalcula igv y total; mover el total a
        // mano lo dejaria inconsistente con la base.
        const igvPct = acotarIgvPct(cuerpo.igv_pct);
        const igv = redondear2(subtotal * igvPct / 100);
        const total = redondear2(subtotal + igv);
        // No se cae a la fecha actual al editar: si el cuerpo no trae fecha se
        // conserva la que ya tenia la factura. Mandar null a una columna NOT NULL
        // haria fallar toda la edicion por un campo que el usuario ni toco.
        const fechaActual = aFechaSql(actual.rows[0].fecha_factura);
        const fechaNueva = aFechaSql(cuerpo.fecha_factura) || fechaActual;
        const upd = await client.query(
            `UPDATE facturas SET tipo_comprobante = $1, serie = $2, numero = $3, fecha_factura = $4, subtotal = $5, igv_pct = $6,
                    igv = $7, total = $8, moneda = $9, estado = $10, fecha_pago = $11, fecha_vencimiento = $12, observaciones = $13
             WHERE id = $14 RETURNING *`,
            [
                tipoComprobante, String(cuerpo.serie || '').trim().toUpperCase(), numero,
                fechaNueva,
                redondear2(subtotal), igvPct, igv, total,
                normalizarMoneda(cuerpo.moneda), estadoFinal,
                String(cuerpo.fecha_pago || '').trim() || null,
                fechaVenc,
                String(cuerpo.observaciones || '').trim(), id
            ]
        );
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Factura actualizada correctamente.', factura: upd.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, mensaje: 'Ya existe una factura con ese tipo, serie y número.' });
        }
        console.error('Error editar factura:', err);
        res.status(500).json({ success: false, mensaje: 'Error al actualizar la factura: ' + err.message });
    } finally {
        client.release();
    }
});

// Registrar el pago es un cambio de estado, no una edicion del documento: por
// eso va aparte y solo mueve estado y fecha_pago.
app.post('/api/bd/facturas/:id/pagar', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de factura no válido.' });
        }
        const fechaPago = String((req.body || {}).fecha_pago || '').trim();

        await client.query('BEGIN');
        const actual = await client.query('SELECT id, estado FROM facturas WHERE id = $1', [id]);
        if (!actual.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La factura no existe.' });
        }
        // Pagar una factura anulada la resucita como deuda real, y pagar una
        // cancelada contradice de frente lo que se acaba de registrar: se declaro
        // que ese dinero no entra. Se rechazan las dos con el estado actual a la
        // vista, en vez de un UPDATE condicional que dejaria al usuario sin saber
        // por que no se guardo.
        const estadoActual = String(actual.rows[0].estado || '').toUpperCase();
        if (estadoActual === FACTURA_NO_IMPUTABLE || estadoActual === 'CANCELADA') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                mensaje: `No se puede marcar como pagada una factura ${estadoActual === 'CANCELADA' ? 'cancelada' : 'anulada'}.`
            });
        }
        const upd = await client.query(
            `UPDATE facturas SET estado = 'PAGADA', fecha_pago = $1, fecha_vencimiento = NULL WHERE id = $2 RETURNING *`,
            [fechaPago || new Date().toISOString().slice(0, 10), id]
        );
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Factura marcada como pagada.', factura: upd.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error pagar factura:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/bd/facturas/:id', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'ID de factura no válido.' });
        }
        const del = await pool.query('DELETE FROM facturas WHERE id = $1 RETURNING numero', [id]);
        if (!del.rows.length) {
            return res.status(404).json({ success: false, mensaje: 'La factura no existe.' });
        }
        res.json({ success: true, mensaje: 'Factura eliminada.' });
    } catch (err) {
        console.error('Error eliminar factura:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// ---- STOCK DE PROVEEDORES ----
app.get('/api/bd/stock-proveedores', requerirRolBDGeneral, async (req, res) => {
    try {
        const proveedorId = req.query.proveedor_id ? parseInt(req.query.proveedor_id, 10) : null;
        const result = await pool.query(`
            SELECT s.*, p.categoria AS categoria_proveedor
            FROM stock_proveedores s
            LEFT JOIN proveedores p ON LOWER(BTRIM(p.nombre)) = LOWER(BTRIM(s.proveedor_nombre))
            WHERE ($1::int IS NULL OR p.id = $1)
            ORDER BY LOWER(s.proveedor_nombre) ASC, LOWER(s.producto) ASC`, [proveedorId]);
        res.json({ success: true, stock: result.rows });
    } catch (err) {
        console.error('Error GET stock proveedores:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/bd/stock-proveedores/movimientos', requerirRolBDGeneral, async (req, res) => {
    try {
        const proveedorId = req.query.proveedor_id ? parseInt(req.query.proveedor_id, 10) : null;
        const result = await pool.query(`
            SELECT h.*, p.nombre AS proveedor_registrado
            FROM stock_proveedores_historial h
            LEFT JOIN proveedores p ON LOWER(BTRIM(p.nombre)) = LOWER(BTRIM(h.proveedor))
            WHERE ($1::int IS NULL OR p.id = $1)
            ORDER BY h.id DESC LIMIT 300`, [proveedorId]);
        res.json({ success: true, movimientos: result.rows });
    } catch (err) {
        console.error('Error GET movimientos stock proveedores:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/refinado/historial', requerirRolRefinado, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT fecha_reporte, turno, usuario_registro, fecha_registro, totales_json
            FROM reportes_refinado ORDER BY fecha_reporte DESC, turno ASC`);
        const filas = result.rows.map(r => {
            let totales = null;
            try { totales = JSON.parse(r.totales_json); } catch (e) {}
            return {
                fecha_reporte: r.fecha_reporte,
                turno: r.turno,
                usuario_registro: r.usuario_registro,
                fecha_registro: r.fecha_registro,
                total_lotes: totales ? totales.total_lotes : null,
                total_tm: totales ? totales.total_tm : null,
                produccion_manana: totales ? totales.produccion_manana : null
            };
        });
        res.json({ success: true, historial: filas });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Solo arranca el servidor cuando este archivo es el punto de entrada.
// Si otro módulo lo importa (por ejemplo un test), no se ocupa el puerto.
if (require.main === module) {
    // Rate limiter: usa Redis si hay REDIS_URL; si no, sigue con memoria.
    initRedis().catch(() => {});

    app.listen(PORT, () => {
        console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
    });
}

// Los helpers de calculo se exportan para poder probarlos sin levantar el
// servidor: son las reglas que definen los totales de orden y de factura.
module.exports = {
    app, parsearCabeceraSUNAT, detectarItemsTabla, extraerDireccionSUNAT,
    IGV_POR_DEFECTO, normalizarMoneda, redondear2, normalizarItemsOrden,
    camposEntregaDe, normalizarCuentasBancarias
};
