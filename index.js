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
const { esClavePt } = require('./services/catalogoPt');
const { initRedis } = require('./services/rateLimiter');
const { authMiddleware, crearGuardRoles, ROLES_MODULO, requerirRolAdmin, permisoPorRuta } = require('./middleware/auth');
const { calcularInsumosProduccion, calcularInsumosDeReceta, obtenerRecetaVigente, eleccionesDesdeTapa, evaluarCobertura } = require('./services/recipeService');
const { datosParaOrdenPDF, datosFormularioOC } = require('./services/ocPdfDatos');
const { generarPDFOrdenCompra, nombreArchivoSeguro } = require('./services/pdfOrdenCompra');
const { generarPDFPedidoVenta } = require('./services/pdfPedidoVenta');
const { normalizar } = require('./utils/helpers');

process.on('unhandledRejection', (reason) => {
    console.error('Rechazo no manejado:', reason);
});

// Un error no capturado dentro de un callback (p. ej. un socket que se cierra
// a mitad de la respuesta tras un corte breve de red) no debe tumbar el
// proceso: se registra y el servidor sigue atendiendo. Si el estado quedara
// irreparable, Render lo reinicia igual; un parpadeo de red en cambio ya no
// baja el ERP completo.
process.on('uncaughtException', (err) => {
    console.error('Excepción no capturada (el servidor sigue en pie):', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
// Límite explícito de subida: sin él una foto pesada revienta el proceso con
// un error que Express contesta en HTML, y el front (que espera JSON) lo
// termina mostrando como "sin conexión con el servidor".
const LIMITE_SUBIDA_BYTES = 20 * 1024 * 1024;
const upload = multer({ dest: 'public/uploads/', limits: { fileSize: LIMITE_SUBIDA_BYTES, files: 1 } });

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
    'belini_balde18lt': 'Aceite de Soya Belini Balde 18 Lt',
    'vega_900ml': 'Aceite de Soya VEGA 900 ml',
    'timonel_900ml': 'Aceite de Soya TIMONEL 900 ml',
    'fernandez_1lt': 'Aceite de Soya Fernandez 1 Lt',
    'faisan_900ml': 'Aceite de Soya Faisan 900 ml'
};

// --- RUTAS MODULARES ---
const routes = require('./routes');
app.use(routes);

// --- AUTH GLOBAL para el resto de endpoints /api (protege todo salvo /api/login) ---
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  authMiddleware(req, res, next);
});
// Permisos explícitos por usuario y módulo (solo escritura; sin override todo sigue por rol).
app.use('/api', permisoPorRuta);

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
        const esVehiculo = tipo_documento === 'VEHICULO SIN MERCADERIA';
        const estado = esVehiculo ? 'INGRESO SIN MERCADERIA' : 'PENDIENTE CONFORMIDAD';

        const query = `
            INSERT INTO ingresos_vigilancia 
            (tipo_documento, numero_guia, proveedor, chofer, dni_chofer, placa, lugar_partida, punto_llegada, observaciones, foto_url, usuario_vigilancia, items_json, estado, fecha_ingreso)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW()) 
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
            JSON.stringify(items),
            estado
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

        const proveedorId = await resolverProveedorId(client, ingreso.proveedor);

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

            // El nombre puede venir de la guía con otra redacción ("ETIQUETAS
            // BELINI 1LT" vs "Etiqueta couche 90 gr x 1 lt Belini"): se busca el
            // artículo que coincide antes de crear uno nuevo. Solo se crea
            // cuando de verdad no existe ninguno.
            let targetArticuloId = null;
            const hallado = await resolverArticuloPorNombre(client, nombreFinal);
            if (hallado.tipo === 'ambigua') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    mensaje: `"${nombreFinal}" coincide con varios artículos: elige cuál es en vez de crear otro.`,
                    candidatos: hallado.candidatos.map(c => ({ id: c.id, nombre: c.nombre, stock: c.stock }))
                });
            }

            if (hallado.articulo) {
                targetArticuloId = hallado.articulo.id;
                const stockAnterior = Number(hallado.articulo.stock) || 0;
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
                INSERT INTO registro_ingresos_almacen (fecha_registro, numero_guia, proveedor, proveedor_id, producto_nombre, cantidad, estado, articulo_id)
                VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7);
            `, [ingreso.numero_guia, ingreso.proveedor, proveedorId, nombreFinal, cantidadFisica, estadoItem, targetArticuloId]);
        }

        // El descuento contra el stock de proveedores ya no se hace a ciegas por
        // nombre: si la guia llego sin orden, sus filas quedan en SIN_OC y esperan
        // en el boton de Notificaciones de Base de Datos General, que es quien le
        // asigna la OC contra la que abonar.
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
            items_json,
            numero_oc,
            sin_guia
        } = req.body;

        // Ingreso sin guia: el documento todavia no llega, el stock entra ya
        // y el N° de guia se completa despues con el vinculo del registro.
        const sinGuia = String(sin_guia || '') === '1' || sin_guia === true;
        const numeroGuia = sinGuia ? null : numero_guia;
        const refDoc = sinGuia
            ? 'guía pendiente de vincular (sin N°)'
            : 'guía ' + (numero_guia || 'S/N');

        // La OC declarada en la guia se valida antes de abrir la transaccion: una
        // guia con un numero de orden inexistente o de otro proveedor no debe
        // quedar registrada a medias.
        const ordenDeclarada = String(numero_oc || '').trim();
        let ordenAsociada = null;
        if (ordenDeclarada) {
            const buscada = await buscarOrdenParaGuia(client, ordenDeclarada, proveedor);
            if (!buscada.ok) {
                return res.status(400).json({ success: false, mensaje: buscada.mensaje });
            }
            ordenAsociada = buscada.orden;
        }

        await client.query('BEGIN');

        const items = JSON.parse(items_json || '[]');
        if (!Array.isArray(items) || items.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Debe incluir al menos un producto en el ingreso.' });
        }

        const foto_url = req.file ? `/uploads/${req.file.filename}` : null;
        const usuarioRegistro = usuario || 'almacen1';
        const proveedorId = await resolverProveedorId(client, proveedor);

        let tieneDiferencias = false;
        for (const item of items) {
            if (Number(item.cantidad_guia) !== Number(item.cantidad_fisica)) {
                tieneDiferencias = true;
                break;
            }
        }

        const estadoFinal = sinGuia
            ? 'INGRESO SIN GUIA (POR VINCULAR)'
            : tieneDiferencias
                ? 'CONFORME CON DIFERENCIAS (POR REGULARIZAR)'
                : `RECIBIDO POR ${usuarioRegistro}`;

        const insert = await client.query(
            `INSERT INTO ingresos_vigilancia
             (tipo_documento, numero_guia, proveedor, chofer, dni_chofer, placa, lugar_partida, punto_llegada, observaciones, foto_url, usuario_vigilancia, items_json, estado, fecha_ingreso, orden_id, orden_numero)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14, $15)
             RETURNING id, numero_guia`,
            [
                tipo_documento, numeroGuia, proveedor,
                chofer || '', dni_chofer || '', placa || '',
                lugar_partida || '', punto_llegada || 'Planta Principal - Corporación Belcen',
                observaciones || '', foto_url, usuarioRegistro, JSON.stringify(items), estadoFinal,
                ordenAsociada ? ordenAsociada.id : null,
                ordenAsociada ? ordenAsociada.numero : null
            ]
        );
        const ingresoId = insert.rows[0].id;

        let asociados = 0;
        let sinCoincidencia = 0;
        let totalSaldadas = 0;
        const nuevosProductos = [];
        for (const item of items) {
            let estadoItem = 'CON GUIA';
            if (sinGuia) {
                estadoItem = 'SIN GUIA';
            } else if (Number(item.cantidad_guia) !== Number(item.cantidad_fisica)) {
                estadoItem = 'POR REGULARIZAR';
            }

            const cantidadFisica = Number(item.cantidad_fisica) || 0;
            // Busca el producto en 3 capas (exacto, plano sin puntuación y por
            // contenido de tokens con un único candidato). Si coincide con
            // varios no se adivina: se pide el nombre exacto, nunca se crea un
            // duplicado en silencio.
            const halladoRegistro = await resolverArticuloPorNombre(client, item.nombre);
            if (halladoRegistro.tipo === 'ambigua') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    mensaje: `El producto "${item.nombre}" coincide con varios artículos: escribe el nombre exacto de uno de ellos (${halladoRegistro.candidatos.map(c => `"${c.nombre}"`).join(', ')}).`
                });
            }
            const filaInv = halladoRegistro.articulo
                ? { id: halladoRegistro.articulo.id, stock: halladoRegistro.articulo.stock }
                : null;
            let targetArticuloId;
            if (filaInv) {
                targetArticuloId = filaInv.id;
                const stockAnterior = Number(filaInv.stock) || 0;
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidadFisica, targetArticuloId]);
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad',
                    producto: item.nombre, articulo_id: targetArticuloId,
                    cantidad: cantidadFisica, tipo_cambio: 'SUMA',
                    stock_anterior: stockAnterior, stock_nuevo: stockAnterior + cantidadFisica,
                    usuario: usuarioResponsable(req, usuarioRegistro),
                    referencia: 'Conformidad - ' + refDoc
                });
            } else {
                const categoriaNueva = String(item.categoria || '').trim();
                const unidadNueva = String(item.unidad_medida || '').trim() || 'UNIDADES';
                if (!categoriaNueva) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        success: false,
                        mensaje: `El producto "${item.nombre}" no existe en el inventario. Elija una categoría existente o cree una nueva para poder ingresarlo.`
                    });
                }
                const nuevoArt = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) VALUES ($1, $2, $3, $4, 'STOCK SUFICIENTE') RETURNING id`,
                    [item.nombre, categoriaNueva, cantidadFisica, unidadNueva]
                );
                targetArticuloId = nuevoArt.rows[0].id;
                nuevosProductos.push({ nombre: item.nombre, categoria: categoriaNueva });
                await registrarHistorial(client, {
                    tipo: 'ENTRADA', origen: 'conformidad',
                    producto: item.nombre, articulo_id: targetArticuloId,
                    cantidad: cantidadFisica, tipo_cambio: 'SUMA',
                    stock_anterior: 0, stock_nuevo: cantidadFisica,
                    usuario: usuarioResponsable(req, usuarioRegistro),
                    referencia: `Conformidad (artículo nuevo, categoría ${categoriaNueva}) - ` + refDoc
                });
            }
            await actualizarEstadoArticulo(client, item.nombre, targetArticuloId);

            // Auto-saldado: si este insumo tenía pendientes (producción que
            // consumió sin stock), la guía los salda primero —igual que el
            // aplicar manual— y solo el resto queda en stock. Ej: debe 100 y
            // llegan 867 → se saldan 100 y quedan 767.
            let saldadasGuia = 0;
            if (cantidadFisica > 0) {
                saldadasGuia = await regularizarAjustesPendientes(client, {
                    articuloId: targetArticuloId,
                    articuloNombre: item.nombre,
                    usuario: usuarioResponsable(req, usuarioRegistro),
                    vinculoTipo: 'GUIA',
                    vinculoRef: numero_guia || 'S/N',
                    referencia: `Ajuste pendiente saldado con ` + refDoc
                });
                totalSaldadas += saldadasGuia;
            }

            const fila = await client.query(
                `INSERT INTO registro_ingresos_almacen (fecha_registro, numero_guia, proveedor, proveedor_id, producto_nombre, cantidad, estado, articulo_id, asociacion, ingreso_id)
                 VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, 'SIN_OC', $8)
                 RETURNING id`,
                [numeroGuia, proveedor, proveedorId, item.nombre, item.cantidad_fisica, estadoItem, targetArticuloId, ingresoId]
            );

            // Con OC declarada se abona contra el item que empate. Lo que no empate
            // se queda en SIN_OC y aparece en Notificaciones.
            if (ordenAsociada) {
                const r = await asociarItemDeGuia(client, {
                    fila: {
                        id: fila.rows[0].id,
                        cantidad: Number(item.cantidad_fisica) || 0,
                        producto_nombre: item.nombre
                    },
                    orden: ordenAsociada,
                    numeroGuia: numero_guia,
                    usuario: usuarioRegistro
                });
                if (r.ok) asociados++; else sinCoincidencia++;
            }
        }

        await client.query('COMMIT');
        let mensaje = sinGuia
            ? 'Ingreso SIN GUÍA registrado: los productos entraron al inventario. Cuando llegue el documento, vincula el N° de guía desde el Registro de Ingresos (botón "Vincular guía").'
            : 'Ingreso registrado conforme. Stock actualizado.';
        if (ordenAsociada) {
            mensaje = sinCoincidencia
                ? `Ingreso asociado a la orden ${ordenAsociada.numero}. ${sinCoincidencia} producto(s) sin coincidencia quedaron en Notificaciones.`
                : `Ingreso asociado a la orden ${ordenAsociada.numero}. Stock del proveedor descontado.`;
        } else if (!sinGuia && items.length) {
            mensaje = 'Ingreso registrado conforme. Los productos quedaron en Notificaciones hasta que se les asigne una OC.';
        }
        if (totalSaldadas) {
            mensaje += ` Se saldaron ${totalSaldadas} pendiente(s) con esta guía; el resto quedó en stock.`;
        }
        if (nuevosProductos.length) {
            mensaje += ` Productos nuevos creados en el inventario: ${nuevosProductos.map(p => `${p.nombre} [${p.categoria}]`).join(', ')}.`;
        }
        res.json({
            success: true,
            mensaje,
            ingreso: { id: ingresoId, numero_guia: numeroGuia },
            sin_guia: sinGuia,
            asociados,
            sin_coincidencia: sinCoincidencia,
            pendientes_saldados: totalSaldadas,
            nuevos_productos: nuevosProductos
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en registrar-conforme:', err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar el ingreso conforme: ' + err.message });
    } finally {
        client.release();
    }
});

// --- ALMACÉN: VINCULAR UN INGRESO REGISTRADO SIN GUÍA ---
// El ingreso sin guía ya sumó stock; aquí se le completa el documento cuando
// llega: N° de guía, proveedor y tipo, y las filas del registro dejan el
// estado SIN GUIA para quedar como cualquier otra entrada conforme.
app.post('/api/almacen/ingresos/:id/vincular-guia', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const ingresoId = Number(req.params.id);
        const { numero_guia, proveedor, tipo_documento, usuario } = req.body || {};
        const guia = String(numero_guia || '').trim();
        if (!guia) {
            return res.status(400).json({ success: false, mensaje: 'Indica el N° de guía a vincular.' });
        }

        await client.query('BEGIN');
        const cab = await client.query('SELECT * FROM ingresos_vigilancia WHERE id = $1 FOR UPDATE', [ingresoId]);
        if (!cab.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El ingreso no existe.' });
        }
        const ingreso = cab.rows[0];
        if (!/SIN GUIA/i.test(String(ingreso.estado || ''))) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Este ingreso no está pendiente de vincular una guía.' });
        }

        const usuarioResp = usuarioResponsable(req, usuario || 'almacen1');
        const proveedorEfectivo = String(proveedor || '').trim() || ingreso.proveedor;
        const tipoEfectivo = String(tipo_documento || '').trim() || ingreso.tipo_documento || 'GUIA DE REMISION';

        await client.query(
            `UPDATE ingresos_vigilancia
                SET numero_guia = $1, proveedor = $2, tipo_documento = $3,
                    estado = $4, observaciones = COALESCE(NULLIF(observaciones, ''), $5)
              WHERE id = $6`,
            [guia, proveedorEfectivo, tipoEfectivo,
                `VINCULADA A GUIA ${guia} POR ${usuarioResp}`,
                `Guía ${guia} vinculada el ${new Date().toLocaleDateString('es-PE')}`, ingresoId]
        );

        const proveedorId = await resolverProveedorId(client, proveedorEfectivo);
        const filasVinculadas = await client.query(
            `UPDATE registro_ingresos_almacen
                SET numero_guia = $1, proveedor = $2, proveedor_id = $3, estado = 'CON GUIA'
              WHERE ingreso_id = $4 AND estado = 'SIN GUIA'`,
            [guia, proveedorEfectivo, proveedorId, ingresoId]
        );

        await client.query('COMMIT');
        const n = filasVinculadas.rowCount || 0;
        res.json({
            success: true,
            mensaje: `Ingreso vinculado a la guía ${guia}.${n ? ` ${n} producto(s) actualizados en el registro.` : ' Sin filas de registro pendientes.'}`,
            numero_guia: guia,
            filas_vinculadas: n
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error al vincular guía del ingreso:', err);
        res.status(500).json({ success: false, mensaje: 'Error al vincular la guía: ' + err.message });
    } finally {
        client.release();
    }
});

// --- ALMACÉN: VALIDAR EL N° DE OC QUE SE DECLARA EN LA GUIA ---
// El asistente de ingreso lo consulta al salir del campo para avisar en el paso 1
// si la orden no existe o si es de otro proveedor, antes de cargar la carga.
app.post('/api/almacen/guia-orden/validar', gAlmacen, async (req, res) => {
    try {
        const cuerpo = req.body || {};
        const buscada = await buscarOrdenParaGuia(pool, cuerpo.numero_oc, cuerpo.proveedor);
        if (!buscada.ok) return res.status(400).json({ success: false, mensaje: buscada.mensaje });

        const orden = buscada.orden;
        const pend = (await pool.query(
            `SELECT COUNT(*)::int AS n_items,
                    COALESCE(SUM(cantidad), 0) AS total_cantidad,
                    COALESCE(SUM(recibido), 0) AS total_recibido
               FROM ordenes_items WHERE orden_id = $1`,
            [orden.id]
        )).rows[0];

        res.json({
            success: true,
            mensaje: `Orden ${orden.numero} de ${orden.proveedor_nombre} verificada.`,
            orden: {
                id: orden.id,
                numero: orden.numero,
                tipo: orden.tipo,
                estado: orden.estado,
                proveedor_nombre: orden.proveedor_nombre,
                n_items: pend.n_items,
                total_cantidad: Number(pend.total_cantidad) || 0,
                total_recibido: Number(pend.total_recibido) || 0
            }
        });
    } catch (err) {
        console.error('Error validar guia-orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al validar la orden: ' + err.message });
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

        const proveedorId = await resolverProveedorId(client, ingreso.proveedor);

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

            const halladoAjuste = await resolverArticuloPorNombre(client, nombre);
            if (halladoAjuste.tipo === 'ambigua') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    mensaje: `"${nombre}" coincide con varios artículos: elige cuál es en vez de crear otro.`,
                    candidatos: halladoAjuste.candidatos.map(c => ({ id: c.id, nombre: c.nombre, stock: c.stock }))
                });
            }
            let targetArticuloId;
            if (halladoAjuste.articulo) {
                targetArticuloId = halladoAjuste.articulo.id;
                const stockAnterior = Number(halladoAjuste.articulo.stock) || 0;
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
                INSERT INTO registro_ingresos_almacen (fecha_registro, numero_guia, proveedor, proveedor_id, producto_nombre, cantidad, estado, articulo_id, categoria, unidad_medida)
                VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9);
            `, [ingreso.numero_guia, ingreso.proveedor, proveedorId, nombre, cantidad, estadoItem, targetArticuloId, categoria, unidad_medida]);
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
// Resuelve nombres de guía contra el inventario SIN escribir nada: lo usa la
// conformidad para que solo lo que de verdad no existe pida datos de artículo
// nuevo. Por ítem responde 'unico' (con articulo), 'ninguno' o 'ambiguo' (con
// candidatos para que el operario elija en vez de crear un duplicado).
app.post('/api/almacen/resolver-items', gAlmacen, async (req, res) => {
    try {
        const nombres = Array.isArray(req.body.nombres) ? req.body.nombres : [];
        const items = [];
        for (const n of nombres) {
            const r = await resolverArticuloPorNombre(pool, n);
            const unico = r.tipo === 'exacta' || r.tipo === 'variante' || r.tipo === 'similar';
            items.push({
                nombre: String(n || ''),
                tipo: unico ? 'unico' : (r.tipo === 'ambigua' ? 'ambiguo' : 'ninguno'),
                articulo: r.articulo
                    ? { id: r.articulo.id, nombre: r.articulo.nombre, stock: r.articulo.stock }
                    : null,
                candidatos: (r.candidatos || []).map(c => ({ id: c.id, nombre: c.nombre, stock: c.stock }))
            });
        }
        res.json({ success: true, items });
    } catch (err) {
        console.error('Error al resolver items:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

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

        const existe = await resolverArticuloPorNombre(pool, nom);
        if (existe.articulo) {
            return res.status(400).json({ success: false, mensaje: `Ya existe "${existe.articulo.nombre}" en el inventario (coincide con "${nom}"). Usa el botón Ajustar para corregir su stock.` });
        }
        if (existe.tipo === 'ambigua') {
            return res.status(409).json({
                success: false,
                mensaje: `"${nom}" se parece a varios artículos: verifica si uno de ellos es el que quieres crear.`,
                candidatos: existe.candidatos.map(c => ({ id: c.id, nombre: c.nombre, stock: c.stock }))
            });
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

// --- ALMACEN: ELIMINAR ARTICULO DEL INVENTARIO (solo admin) ---
// Borrado en cascada: primero las filas que referencian al articulo
// (guias de almacen, salidas y recetas) y luego el articulo. El historial
// no tiene FK y se conserva; ademas se anota la ELIMINACION para auditoria.
app.delete('/api/inventario/:id', requerirRolAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const articulo_id = parseInt(req.params.id, 10);
        if (!articulo_id) {
            return res.status(400).json({ success: false, mensaje: 'Id de artículo inválido.' });
        }
        await client.query('BEGIN');
        const actual = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [articulo_id]);
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El artículo no existe.' });
        }
        const nombreArticulo = actual.rows[0].nombre;
        const stockAnterior = Number(actual.rows[0].stock) || 0;
        const guias = await client.query('DELETE FROM registro_ingresos_almacen WHERE articulo_id = $1', [articulo_id]);
        const salidas = await client.query('DELETE FROM salidas_almacen WHERE articulo_id = $1', [articulo_id]);
        const recetas = await client.query('DELETE FROM receta_insumos WHERE insumo_id = $1', [articulo_id]);
        await client.query('DELETE FROM inventario WHERE id = $1', [articulo_id]);
        await registrarHistorial(client, {
            tipo: 'ELIMINACION',
            origen: 'almacen',
            producto: nombreArticulo,
            articulo_id: articulo_id,
            cantidad: stockAnterior,
            tipo_cambio: 'RESTA',
            stock_anterior: stockAnterior,
            stock_nuevo: 0,
            usuario: usuarioResponsable(req, req.body && req.body.usuario),
            referencia: `Eliminación manual de artículo (admin): ${guias.rowCount} guías, ${salidas.rowCount} salidas, ${recetas.rowCount} recetas desvinculadas`
        });
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Artículo "${nombreArticulo}" eliminado (${guias.rowCount} guías, ${salidas.rowCount} salidas, ${recetas.rowCount} recetas desvinculadas).` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23503') {
            return res.status(409).json({ success: false, mensaje: 'No se puede eliminar: otra tabla todavía referencia al artículo.' });
        }
        console.error("Error al eliminar artículo:", err);
        res.status(500).json({ success: false, mensaje: 'Error al eliminar el artículo: ' + err.message });
    } finally {
        client.release();
    }
});

// --- ALMACEN: RENOMBRAR ARTICULO DEL INVENTARIO (solo admin) ---
// El cambio es inmediato en todos los modulos porque leen el inventario en
// vivo (stock, soplado, recetas por join, dashboard). Los historiales viejos
// conservan el nombre anterior como snapshot de auditoria.
app.put('/api/inventario/:id', requerirRolAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const articulo_id = parseInt(req.params.id, 10);
        const nombreNuevo = String((req.body && req.body.nombre) || '').trim();
        if (!articulo_id) {
            return res.status(400).json({ success: false, mensaje: 'Id de artículo inválido.' });
        }
        if (!nombreNuevo) {
            return res.status(400).json({ success: false, mensaje: 'El nuevo nombre no puede estar vacío.' });
        }
        if (nombreNuevo.length > 150) {
            return res.status(400).json({ success: false, mensaje: 'El nombre no puede superar 150 caracteres.' });
        }
        await client.query('BEGIN');
        const actual = await client.query('SELECT nombre FROM inventario WHERE id = $1', [articulo_id]);
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El artículo no existe.' });
        }
        const nombreAnterior = actual.rows[0].nombre;
        if (nombreAnterior === nombreNuevo) {
            await client.query('ROLLBACK');
            return res.json({ success: true, mensaje: 'Sin cambios: el nombre es el mismo.' });
        }
        const duplicado = await client.query(
            'SELECT id FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) AND id <> $2',
            [nombreNuevo, articulo_id]
        );
        if (duplicado.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, mensaje: `Ya existe otro artículo con el nombre "${nombreNuevo}".` });
        }
        await client.query('UPDATE inventario SET nombre = $1 WHERE id = $2', [nombreNuevo, articulo_id]);
        await registrarHistorial(client, {
            tipo: 'EDICION',
            origen: 'almacen',
            producto: nombreNuevo,
            articulo_id: articulo_id,
            cantidad: 0,
            tipo_cambio: 'SUMA',
            stock_anterior: null,
            stock_nuevo: null,
            usuario: usuarioResponsable(req, req.body && req.body.usuario),
            referencia: `Cambio de nombre (admin): "${nombreAnterior}" → "${nombreNuevo}"`
        });
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Artículo renombrado a "${nombreNuevo}".` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("Error al renombrar artículo:", err);
        res.status(500).json({ success: false, mensaje: 'Error al renombrar el artículo: ' + err.message });
    } finally {
        client.release();
    }
});

// --- SERVICIOS EXTERNOS DE SOPLADO (SAUÑE / B&M DYLPLAST) ---
// Se les envian etiquetas y preformas (millares): el ENVIO ya descuenta el
// inventario al salir. Cuando llegan guia o control interno suman las
// botellas y consumen primero el saldo enviado a ese servicio; del
// inventario solo baja el excedente que el envio no cubre. El CONTROL nace
// PENDIENTE de guia y la GUIA, de factura.
const SERVICIOS_SOPLADO = ['SAUÑE', 'B&M DYLPLAST'];

// Resuelve etiqueta y preforma para un producto via su receta activa.
// Devuelve { etiqueta: {id, nombre, stock}, preforma: {...} } o faltantes.
async function resolverInsumosServicio(q, productoKey) {
    const out = { etiqueta: null, preforma: null };
    if (!productoKey) return out;
    const rec = await q.query(
        `SELECT id FROM recetas WHERE producto_key = $1 AND activa = true ORDER BY version DESC LIMIT 1`,
        [productoKey]
    );
    if (!rec.rows.length) return out;
    const ins = await q.query(
        `SELECT ri.insumo_id AS id, inv.nombre, inv.categoria, inv.stock
           FROM receta_insumos ri
           LEFT JOIN inventario inv ON inv.id = ri.insumo_id
          WHERE ri.receta_id = $1 AND ri.componente_receta_id IS NULL`,
        [rec.rows[0].id]
    );
    for (const l of ins.rows) {
        const cat = String(l.categoria || '').toUpperCase();
        if (!out.etiqueta && cat.includes('ETIQUETA') && l.id) {
            out.etiqueta = { id: l.id, nombre: l.nombre, stock: Number(l.stock) || 0 };
        }
        if (!out.preforma && cat.includes('PREFORMA') && l.id) {
            out.preforma = { id: l.id, nombre: l.nombre, stock: Number(l.stock) || 0 };
        }
    }
    return out;
}

// Saldo disponible de lo enviado a un servicio: por articulo, lo enviado en
// servicios_envios menos lo ya consumido por guias y controles registrados.
// Devuelve Map<articulo_id, saldo> (negativo si se recibio mas de lo enviado).
async function saldoEnvioServicio(q, servicio) {
    const env = await q.query(
        `SELECT articulo_id, COALESCE(SUM(cantidad), 0) AS enviado
           FROM servicios_envios
          WHERE servicio = $1
          GROUP BY articulo_id`,
        [servicio]
    );
    const con = await q.query(
        `SELECT i.etiqueta_id AS articulo_id, COALESCE(SUM(i.cant_etiquetas), 0) AS consumido
           FROM servicios_guias_items i
           JOIN servicios_guias g ON g.id = i.guia_id
          WHERE g.servicio = $1 AND i.etiqueta_id IS NOT NULL
          GROUP BY i.etiqueta_id
         UNION ALL
         SELECT i.preforma_id, COALESCE(SUM(i.cant_preformas), 0)
           FROM servicios_guias_items i
           JOIN servicios_guias g ON g.id = i.guia_id
          WHERE g.servicio = $1 AND i.preforma_id IS NOT NULL
          GROUP BY i.preforma_id`,
        [servicio]
    );
    const saldo = new Map();
    for (const e of env.rows) saldo.set(e.articulo_id, Number(e.enviado) || 0);
    for (const c of con.rows) {
        if (!c.articulo_id) continue;
        saldo.set(c.articulo_id, (saldo.get(c.articulo_id) || 0) - (Number(c.consumido) || 0));
    }
    return saldo;
}

// Reparte un consumo de insumos entre el saldo ya enviado al servicio y el
// inventario: consume el saldo primero y devuelve el excedente (parte que
// aun no se habia enviado y por tanto sale del inventario). Descuenta el
// saldo usado del Map para que varias lineas del mismo documento no lo
// consuman dos veces.
function consumirSaldoEnvio(saldo, articuloId, cantidad) {
    const disponible = Math.max(0, saldo.get(articuloId) || 0);
    const desdeEnvio = Math.min(cantidad, disponible);
    saldo.set(articuloId, (saldo.get(articuloId) || 0) - desdeEnvio);
    return {
        desdeEnvio,
        excedente: Math.round(((cantidad - desdeEnvio) + Number.EPSILON) * 1000000) / 1000000
    };
}

// Busca la botella que llega del servicio por nombre: exacto primero y, si no,
// normalizado (sin acentos, sin la "x" separadora, sin espacios) para tolerar
// lo escrito a mano ("Botella belini 900ml" vs "Botella Belini x 900 ml").
// Devuelve {id, nombre, stock} o null (no existe o ambiguo).
async function buscarBotellaServicio(client, nombre) {
    const ex = await client.query(
        'SELECT id, nombre, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1))',
        [nombre]
    );
    if (ex.rows.length === 1) return ex.rows[0];
    if (ex.rows.length > 1) return null;
    const clave = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9]+/).filter(t => t && t !== 'x').join('');
    const k = clave(nombre);
    if (!k) return null;
    const cands = await client.query(
        `SELECT id, nombre, stock FROM inventario
          WHERE UPPER(categoria) LIKE '%BOTELLA%' OR UPPER(categoria) LIKE '%GALONERA%'`
    );
    const hits = cands.rows.filter(r => clave(r.nombre) === k);
    return hits.length === 1 ? hits[0] : null;
}

// Panel: saldos por servicio e insumo + guias con su factura.
app.get('/api/servicios/panel', async (req, res) => {
    try {
        const env = await pool.query(
            `SELECT servicio, articulo_id, articulo_nombre, tipo_item,
                    COALESCE(SUM(cantidad), 0) AS enviado
               FROM servicios_envios GROUP BY servicio, articulo_id, articulo_nombre, tipo_item`
        );
        const con = await pool.query(
            `SELECT g.servicio,
                    i.etiqueta_id AS articulo_id, i.etiqueta_nombre AS nombre,
                    COALESCE(SUM(i.cant_etiquetas), 0) AS entregado
               FROM servicios_guias_items i
               JOIN servicios_guias g ON g.id = i.guia_id
              WHERE g.tipo_doc IN ('GUIA', 'CONTROL') AND i.etiqueta_id IS NOT NULL
              GROUP BY g.servicio, i.etiqueta_id, i.etiqueta_nombre
              UNION ALL
             SELECT g.servicio,
                    i.preforma_id AS articulo_id, i.preforma_nombre AS nombre,
                    COALESCE(SUM(i.cant_preformas), 0) AS entregado
               FROM servicios_guias_items i
               JOIN servicios_guias g ON g.id = i.guia_id
              WHERE g.tipo_doc IN ('GUIA', 'CONTROL') AND i.preforma_id IS NOT NULL
              GROUP BY g.servicio, i.preforma_id, i.preforma_nombre`
        );
        const entregadoPor = {};
        for (const c of con.rows) {
            const k = c.servicio + '|' + c.articulo_id;
            entregadoPor[k] = (entregadoPor[k] || 0) + Number(c.entregado);
        }
        const servicios = SERVICIOS_SOPLADO.map(sv => {
            const insumos = env.rows
                .filter(e => e.servicio === sv)
                .map(e => {
                    const cons = entregadoPor[sv + '|' + e.articulo_id] || 0;
                    const enviado = Number(e.enviado) || 0;
                    return {
                        articulo_id: e.articulo_id,
                        nombre: e.articulo_nombre,
                        tipo_item: e.tipo_item,
                        unidad_medida: 'MILLARES',
                        enviado,
                        entregado: cons,
                        saldo: enviado - cons
                    };
                });
            return { servicio: sv, insumos };
        });
        const guias = await pool.query(
            `SELECT * FROM servicios_guias ORDER BY fecha DESC NULLS LAST, id DESC LIMIT 200`
        );
        let lineasPorGuia = {};
        try {
            const lin = await pool.query(
                `SELECT * FROM servicios_guias_items ORDER BY guia_id, id`
            );
            for (const l of lin.rows) {
                (lineasPorGuia[l.guia_id] = lineasPorGuia[l.guia_id] || []).push(l);
            }
        } catch (e) {
            lineasPorGuia = {};
        }
        for (const g of guias.rows) g.lineas = lineasPorGuia[g.id] || [];
        const pendientes = await pool.query(
            `SELECT servicio, COUNT(*)::int AS n FROM servicios_guias
              WHERE tipo_doc = 'CONTROL' AND estado = 'PENDIENTE' GROUP BY servicio`
        );
        const sinFactura = await pool.query(
            `SELECT servicio, COUNT(*)::int AS n FROM servicios_guias
              WHERE tipo_doc = 'GUIA' AND factura_estado = 'PENDIENTE' GROUP BY servicio`
        );
        res.json({ success: true, servicios, guias: guias.rows, pendientes: pendientes.rows, sinFactura: sinFactura.rows });
    } catch (err) {
        console.error('Error en panel de servicios:', err);
        if (err && err.code === '42P01') {
            // Tablas aun no creadas: la migracion esta pendiente de aplicar.
            return res.json({
                success: true, migracionPendiente: true, servicios: [],
                guias: [], pendientes: [], sinFactura: []
            });
        }
        res.status(500).json({ success: false, mensaje: 'Error al cargar el panel de servicios: ' + err.message });
    }
});

// Controles pendientes de un servicio (para vincularlos a una guia).
app.get('/api/servicios/controles-pendientes', async (req, res) => {
    try {
        const servicio = String(req.query.servicio || '').trim().toUpperCase();
        if (!SERVICIOS_SOPLADO.includes(servicio)) {
            return res.status(400).json({ success: false, mensaje: 'Servicio inválido.' });
        }
        const r = await pool.query(
            `SELECT id, numero, fecha, producto, cantidad FROM servicios_guias
              WHERE servicio = $1 AND tipo_doc = 'CONTROL' AND estado = 'PENDIENTE'
              ORDER BY fecha DESC NULLS LAST, id DESC`,
            [servicio]
        );
        res.json({ success: true, controles: r.rows });
    } catch (err) {
        console.error('Error en controles pendientes:', err);
        res.status(500).json({ success: false, mensaje: 'Error al cargar controles: ' + err.message });
    }
});

// Sugiere etiqueta y preforma para un producto via su receta activa.
app.get('/api/servicios/resolver', async (req, res) => {
    try {
        let productoKey = String(req.query.producto_key || '').trim();
        const productoNombre = String(req.query.producto || '').trim();
        if (!productoKey && productoNombre) {
            const pt = await pool.query(
                'SELECT producto_key FROM producto_terminado WHERE LOWER(nombre_producto) = LOWER($1) LIMIT 1',
                [productoNombre]
            );
            if (pt.rows.length) productoKey = pt.rows[0].producto_key;
        }
        if (!productoKey) {
            return res.json({ success: true, etiqueta: null, preforma: null });
        }
        const r = await resolverInsumosServicio(pool, productoKey);
        res.json({ success: true, etiqueta: r.etiqueta, preforma: r.preforma });
    } catch (err) {
        console.error('Error al resolver insumos:', err);
        res.status(500).json({ success: false, mensaje: 'Error al resolver insumos: ' + err.message });
    }
});

// Registrar envio de insumos al servicio (descuenta stock en millares).
// Acepta una o varias lineas: items: [{ articulo_id, cantidad }].
app.post('/api/servicios/envios', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const servicio = String(req.body.servicio || '').trim().toUpperCase();
        const items = Array.isArray(req.body.items) && req.body.items.length
            ? req.body.items
            : [{ articulo_id: req.body.articulo_id, cantidad: req.body.cantidad }];
        if (!SERVICIOS_SOPLADO.includes(servicio)) {
            return res.status(400).json({ success: false, mensaje: 'Servicio inválido (SAUÑE o B&M DYLPLAST).' });
        }
        if (!items.length) {
            return res.status(400).json({ success: false, mensaje: 'Agrega al menos un insumo al envío.' });
        }
        await client.query('BEGIN');
        const lineas = [];
        for (const it of items) {
            const articulo_id = parseInt(it.articulo_id, 10);
            const cantidad = Number(it.cantidad);
            if (!articulo_id || !(cantidad > 0)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: 'Cada línea necesita artículo y cantidad válida.' });
            }
            const art = await client.query('SELECT nombre, categoria, stock FROM inventario WHERE id = $1', [articulo_id]);
            if (!art.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, mensaje: 'Un artículo del envío no existe.' });
            }
            const cat = String(art.rows[0].categoria || '').toUpperCase();
            const tipoItem = cat.includes('ETIQUETA') ? 'ETIQUETA' : (cat.includes('PREFORMA') ? 'PREFORMA' : '');
            if (!tipoItem) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `Solo se envían etiquetas o preformas ("${art.rows[0].nombre}" no lo es).` });
            }
            const stockActual = Number(art.rows[0].stock) || 0;
            if (stockActual < cantidad) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `Stock insuficiente de "${art.rows[0].nombre}" (disponible: ${stockActual}).` });
            }
            await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [cantidad, articulo_id]);
            await actualizarEstadoArticulo(client, null, articulo_id);
            await client.query(
                `INSERT INTO servicios_envios (fecha, servicio, articulo_id, articulo_nombre, tipo_item, cantidad, usuario)
                 VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6)`,
                [servicio, articulo_id, art.rows[0].nombre, tipoItem, cantidad, usuarioResponsable(req, req.body.usuario)]
            );
            await registrarHistorial(client, {
                tipo: 'SALIDA', origen: 'servicio_envio',
                producto: art.rows[0].nombre, articulo_id,
                cantidad, tipo_cambio: 'RESTA',
                stock_anterior: stockActual, stock_nuevo: stockActual - cantidad,
                usuario: usuarioResponsable(req, req.body.usuario),
                referencia: `Envío a servicio ${servicio}`
            });
            lineas.push(`"${art.rows[0].nombre}" x ${cantidad}`);
        }
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Enviado a ${servicio}: ${lineas.join('; ')} (MILLARES).` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error en envío a servicio:', err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar el envío: ' + err.message });
    } finally {
        client.release();
    }
});

// Registrar guia o control interno de llegada del servicio.
// Ambos suman las botellas al inventario (varios modelos por documento).
// El CONTROL nace PENDIENTE de guia; la GUIA vinculada a controles es solo
// documental (el stock ya ingreso con esos controles: evita doble conteo).
// La GUIA sin controles descuenta etiqueta+preforma por botella y nace
// PENDIENTE de factura.
app.post('/api/servicios/guias', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const servicio = String(req.body.servicio || '').trim().toUpperCase();
        const tipoDoc = String(req.body.tipo_doc || '').trim().toUpperCase();
        const numero = String(req.body.numero || '').trim();
        const fecha = req.body.fecha || null;
        if (!SERVICIOS_SOPLADO.includes(servicio)) {
            return res.status(400).json({ success: false, mensaje: 'Servicio inválido (SAUÑE o B&M DYLPLAST).' });
        }
        if (tipoDoc !== 'GUIA' && tipoDoc !== 'CONTROL') {
            return res.status(400).json({ success: false, mensaje: 'Tipo de documento inválido (GUIA o CONTROL).' });
        }
        if (!numero) {
            return res.status(400).json({ success: false, mensaje: 'Número de guía o control requerido.' });
        }
        // Lineas: una guia trae VARIOS productos. Compat: campos sueltos = una sola linea.
        const items = Array.isArray(req.body.items) && req.body.items.length
            ? req.body.items
            : [{
                producto: req.body.producto, producto_key: req.body.producto_key,
                cantidad: req.body.cantidad,
                etiqueta_id: req.body.etiqueta_id, preforma_id: req.body.preforma_id
            }];
        const lineas = [];
        for (const it of items) {
            const prod = String((it && it.producto) || '').trim();
            const cant = Number(it && it.cantidad);
            if (!prod || !(cant > 0)) {
                return res.status(400).json({ success: false, mensaje: 'Cada producto necesita nombre y cantidad válida.' });
            }
            lineas.push({
                producto: prod,
                producto_key: String((it && it.producto_key) || '').trim() || null,
                cantidad: cant,
                etiqueta_id: it && it.etiqueta_id ? parseInt(it.etiqueta_id, 10) : null,
                preforma_id: it && it.preforma_id ? parseInt(it.preforma_id, 10) : null
            });
        }
        await client.query('BEGIN');
        const dup = await client.query(
            'SELECT id FROM servicios_guias WHERE servicio = $1 AND tipo_doc = $2 AND numero = $3',
            [servicio, tipoDoc, numero]
        );
        if (dup.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, mensaje: `El ${tipoDoc === 'GUIA' ? 'n° de guía' : 'control interno'} "${numero}" ya está registrado para ${servicio}.` });
        }

        const usuario = usuarioResponsable(req, req.body.usuario);
        const detalle = [];
        // Ajustes pendientes que se saldan solos al entrar las botellas.
        let saldadasServicio = 0;

        if (tipoDoc === 'GUIA') {
            let controlesIds = [];
            if (Array.isArray(req.body.controles_ids)) {
                controlesIds = req.body.controles_ids.map(v => parseInt(v, 10)).filter(v => v);
            }
            if (controlesIds.length) {
                const propios = await client.query(
                    `SELECT id FROM servicios_guias
                      WHERE id = ANY($1::int[]) AND servicio = $2 AND tipo_doc = 'CONTROL' AND estado = 'PENDIENTE'`,
                    [controlesIds, servicio]
                );
                if (propios.rows.length !== controlesIds.length) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: 'Algún control a vincular no existe, es de otro servicio o ya fue vinculado.' });
                }
            }
            const esDocumental = controlesIds.length > 0;
            // Saldo de lo que ya se envió a este servicio: las guías lo
            // consumen antes de tocar el inventario (el envío ya lo descontó).
            const saldoServicio = esDocumental ? null : await saldoEnvioServicio(client, servicio);
            for (const ln of lineas) {
                if (!esDocumental) {
                    if ((!ln.etiqueta_id || !ln.preforma_id) && !ln.producto_key) {
                        const pt = await client.query(
                            'SELECT producto_key FROM producto_terminado WHERE LOWER(nombre_producto) = LOWER($1) LIMIT 1',
                            [ln.producto]
                        );
                        if (pt.rows.length) ln.producto_key = pt.rows[0].producto_key;
                    }
                    if ((!ln.etiqueta_id || !ln.preforma_id) && ln.producto_key) {
                        const sugeridos = await resolverInsumosServicio(client, ln.producto_key);
                        if (!ln.etiqueta_id && sugeridos.etiqueta) ln.etiqueta_id = sugeridos.etiqueta.id;
                        if (!ln.preforma_id && sugeridos.preforma) ln.preforma_id = sugeridos.preforma.id;
                    }
                    if (!ln.etiqueta_id || !ln.preforma_id) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ success: false, mensaje: `Indica qué etiqueta y qué preforma descuenta "${ln.producto}" (o registra su receta).` });
                    }
                }
                // Las botellas que trae el servicio ingresan al inventario.
                const bRow = await buscarBotellaServicio(client, ln.producto);
                if (!bRow) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `La botella "${ln.producto}" no existe en el inventario (o el nombre es ambiguo). Usa el nombre exacto o créala primero.` });
                }
                ln.botella_id = bRow.id;
                if (esDocumental) continue; // el stock ya ingreso con los controles
                const cantMill = Math.round(((ln.cantidad / 1000) + Number.EPSILON) * 1000000) / 1000000;
                const eRow = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [ln.etiqueta_id]);
                const pRow = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [ln.preforma_id]);
                if (!eRow.rows.length || !pRow.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `La etiqueta o preforma de "${ln.producto}" no existe.` });
                }
                ln.etiqueta_nombre = eRow.rows[0].nombre;
                ln.preforma_nombre = pRow.rows[0].nombre;
                ln.cantMill = cantMill;
                // Lo enviado al servicio ya salió del inventario al registrar
                // el envío: primero se consume ese saldo y solo el excedente
                // (lo que nunca se envió) baja del inventario aquí.
                const etqParte = consumirSaldoEnvio(saldoServicio, ln.etiqueta_id, cantMill);
                const prefParte = consumirSaldoEnvio(saldoServicio, ln.preforma_id, cantMill);
                if ((Number(eRow.rows[0].stock) || 0) < etqParte.excedente || (Number(pRow.rows[0].stock) || 0) < prefParte.excedente) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `Stock insuficiente de etiqueta/preforma para "${ln.producto}" (${Math.max(etqParte.excedente, prefParte.excedente)} MILLARES).` });
                }
                const stockBotAnt = Number(bRow.stock) || 0;
                if (etqParte.excedente > 0) {
                    await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [etqParte.excedente, ln.etiqueta_id]);
                    await actualizarEstadoArticulo(client, null, ln.etiqueta_id);
                    await registrarHistorial(client, {
                        tipo: 'SALIDA', origen: 'servicio_guia',
                        producto: ln.etiqueta_nombre, articulo_id: ln.etiqueta_id,
                        cantidad: etqParte.excedente, tipo_cambio: 'RESTA',
                        stock_anterior: Number(eRow.rows[0].stock) || 0,
                        stock_nuevo: (Number(eRow.rows[0].stock) || 0) - etqParte.excedente,
                        usuario,
                        referencia: `Guía ${numero} de ${servicio} (${ln.producto} x ${ln.cantidad})`
                    });
                }
                if (prefParte.excedente > 0) {
                    await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [prefParte.excedente, ln.preforma_id]);
                    await actualizarEstadoArticulo(client, null, ln.preforma_id);
                    await registrarHistorial(client, {
                        tipo: 'SALIDA', origen: 'servicio_guia',
                        producto: ln.preforma_nombre, articulo_id: ln.preforma_id,
                        cantidad: prefParte.excedente, tipo_cambio: 'RESTA',
                        stock_anterior: Number(pRow.rows[0].stock) || 0,
                        stock_nuevo: (Number(pRow.rows[0].stock) || 0) - prefParte.excedente,
                        usuario,
                        referencia: `Guía ${numero} de ${servicio} (${ln.producto} x ${ln.cantidad})`
                    });
                }
                await client.query('UPDATE inventario SET stock = stock + $1 WHERE id = $2', [ln.cantidad, ln.botella_id]);
                await actualizarEstadoArticulo(client, null, ln.botella_id);
                await registrarHistorial(client, {
                    tipo: 'MOVIMIENTO', origen: 'servicio_guia',
                    producto: ln.producto, articulo_id: ln.botella_id,
                    cantidad: ln.cantidad, tipo_cambio: 'SUMA',
                    stock_anterior: stockBotAnt, stock_nuevo: stockBotAnt + ln.cantidad,
                    usuario,
                    referencia: `Ingreso de botellas por guía ${numero} de ${servicio}`
                });
                // Las botellas entraron: si ese artículo tenía un ajuste
                // pendiente de envasado, se salda solo aquí mismo.
                saldadasServicio += await regularizarAjustesPendientes(client, {
                    articuloId: ln.botella_id,
                    articuloNombre: ln.producto,
                    usuario,
                    vinculoTipo: 'GUIA',
                    vinculoRef: numero,
                    referencia: `Ajuste pendiente saldado con guía ${numero} de ${servicio}`
                });
                detalle.push(`${ln.producto} x ${ln.cantidad} (${cantMill} MILLARES)`);
            }
            if (esDocumental) {
                await client.query(
                    `UPDATE servicios_guias SET estado = 'VINCULADA' WHERE id = ANY($1::int[])`,
                    [controlesIds]
                );
                detalle.push(`${controlesIds.length} control(es) vinculado(s)`);
            }
            const totalBotellas = lineas.reduce((s, l) => s + l.cantidad, 0);
            const primera = lineas[0];
            const resumenProd = primera.producto + (lineas.length > 1 ? ` (+${lineas.length - 1})` : '');
            const cab = await client.query(
                `INSERT INTO servicios_guias (servicio, tipo_doc, numero, fecha, producto, producto_key,
                    cantidad, etiqueta_id, etiqueta_nombre, cant_etiquetas,
                    preforma_id, preforma_nombre, cant_preformas, botella_id,
                    factura_estado, controles_ids, estado, usuario)
                 VALUES ($1, 'GUIA', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDIENTE', $14, 'PENDIENTE', $15)
                 RETURNING id`,
                [servicio, numero, fecha, resumenProd, primera.producto_key, totalBotellas,
                 primera.etiqueta_id, primera.etiqueta_nombre, primera.cantMill,
                 primera.preforma_id, primera.preforma_nombre, primera.cantMill,
                 primera.botella_id, controlesIds, usuario]
            );
            const guiaId = cab.rows[0].id;
            for (const ln of lineas) {
                await client.query(
                    `INSERT INTO servicios_guias_items (guia_id, producto, producto_key, cantidad,
                        etiqueta_id, etiqueta_nombre, cant_etiquetas,
                        preforma_id, preforma_nombre, cant_preformas, botella_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [guiaId, ln.producto, ln.producto_key, ln.cantidad,
                     ln.etiqueta_id, ln.etiqueta_nombre, ln.cantMill,
                     ln.preforma_id, ln.preforma_nombre, ln.cantMill, ln.botella_id]
                );
            }
            await client.query('COMMIT');
            const msgGuia = esDocumental
                ? `Guía ${numero} registrada y vinculada a ${controlesIds.length} control(es): el stock ya ingresó con los controles.`
                : `Guía ${numero} registrada: ${totalBotellas} botellas en ${lineas.length} producto(s): ${detalle.join('; ')}.`
                + (saldadasServicio ? ` Se saldaron ${saldadasServicio} ajuste(s) pendiente(s) con este ingreso.` : '');
            return res.json({ success: true, mensaje: msgGuia });
        }

        // CONTROL: las botellas ingresan al inventario y el documento queda
        // PENDIENTE de guia. Etiqueta/preforma: si la linea no las trae se
        // resuelven por receta (como en la GUIA); se consume primero el saldo
        // enviado al servicio y del inventario solo baja el excedente. Sin
        // insumos resolubles, el control solo suma las botellas.
        const saldoServicioCtrl = await saldoEnvioServicio(client, servicio);
        for (const ln of lineas) {
            if ((!ln.etiqueta_id || !ln.preforma_id) && !ln.producto_key) {
                const pt = await client.query(
                    'SELECT producto_key FROM producto_terminado WHERE LOWER(nombre_producto) = LOWER($1) LIMIT 1',
                    [ln.producto]
                );
                if (pt.rows.length) ln.producto_key = pt.rows[0].producto_key;
            }
            if ((!ln.etiqueta_id || !ln.preforma_id) && ln.producto_key) {
                const sugeridos = await resolverInsumosServicio(client, ln.producto_key);
                // Solo se auto-rellena si la receta trae AMBOS insumos: si
                // trae solo uno, se queda como vino (sin consumir) en vez de
                // rechazar un control que antes se registraba sin insumos.
                if (!ln.etiqueta_id && !ln.preforma_id && sugeridos.etiqueta && sugeridos.preforma) {
                    ln.etiqueta_id = sugeridos.etiqueta.id;
                    ln.preforma_id = sugeridos.preforma.id;
                }
            }
            if ((ln.etiqueta_id && !ln.preforma_id) || (!ln.etiqueta_id && ln.preforma_id)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `En "${ln.producto}" elige etiqueta Y preforma, o ninguna de las dos.` });
            }
            const bRow = await buscarBotellaServicio(client, ln.producto);
            if (!bRow) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `La botella "${ln.producto}" no existe en el inventario (o el nombre es ambiguo). Usa el nombre exacto o créala primero.` });
            }
            ln.botella_id = bRow.id;
            const stockBotAnt = Number(bRow.stock) || 0;
            if (ln.etiqueta_id && ln.preforma_id) {
                const cantMill = Math.round(((ln.cantidad / 1000) + Number.EPSILON) * 1000000) / 1000000;
                const eRow = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [ln.etiqueta_id]);
                const pRow = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1', [ln.preforma_id]);
                if (!eRow.rows.length || !pRow.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `La etiqueta o preforma de "${ln.producto}" no existe.` });
                }
                ln.etiqueta_nombre = eRow.rows[0].nombre;
                ln.preforma_nombre = pRow.rows[0].nombre;
                ln.cantMill = cantMill;
                // El envío ya descontó estas insumos al salir: primero se
                // consume ese saldo y solo el excedente baja del inventario.
                const etqParte = consumirSaldoEnvio(saldoServicioCtrl, ln.etiqueta_id, cantMill);
                const prefParte = consumirSaldoEnvio(saldoServicioCtrl, ln.preforma_id, cantMill);
                if ((Number(eRow.rows[0].stock) || 0) < etqParte.excedente || (Number(pRow.rows[0].stock) || 0) < prefParte.excedente) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `Stock insuficiente de etiqueta/preforma para "${ln.producto}" (${Math.max(etqParte.excedente, prefParte.excedente)} MILLARES).` });
                }
                if (etqParte.excedente > 0) {
                    await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [etqParte.excedente, ln.etiqueta_id]);
                    await actualizarEstadoArticulo(client, null, ln.etiqueta_id);
                    await registrarHistorial(client, {
                        tipo: 'SALIDA', origen: 'servicio_control',
                        producto: ln.etiqueta_nombre, articulo_id: ln.etiqueta_id,
                        cantidad: etqParte.excedente, tipo_cambio: 'RESTA',
                        stock_anterior: Number(eRow.rows[0].stock) || 0,
                        stock_nuevo: (Number(eRow.rows[0].stock) || 0) - etqParte.excedente,
                        usuario,
                        referencia: `Control interno ${numero} de ${servicio} (${ln.producto} x ${ln.cantidad})`
                    });
                }
                if (prefParte.excedente > 0) {
                    await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [prefParte.excedente, ln.preforma_id]);
                    await actualizarEstadoArticulo(client, null, ln.preforma_id);
                    await registrarHistorial(client, {
                        tipo: 'SALIDA', origen: 'servicio_control',
                        producto: ln.preforma_nombre, articulo_id: ln.preforma_id,
                        cantidad: prefParte.excedente, tipo_cambio: 'RESTA',
                        stock_anterior: Number(pRow.rows[0].stock) || 0,
                        stock_nuevo: (Number(pRow.rows[0].stock) || 0) - prefParte.excedente,
                        usuario,
                        referencia: `Control interno ${numero} de ${servicio} (${ln.producto} x ${ln.cantidad})`
                    });
                }
            }
            await client.query('UPDATE inventario SET stock = stock + $1 WHERE id = $2', [ln.cantidad, ln.botella_id]);
            await actualizarEstadoArticulo(client, null, ln.botella_id);
            await registrarHistorial(client, {
                tipo: 'MOVIMIENTO', origen: 'servicio_control',
                producto: ln.producto, articulo_id: ln.botella_id,
                cantidad: ln.cantidad, tipo_cambio: 'SUMA',
                stock_anterior: stockBotAnt, stock_nuevo: stockBotAnt + ln.cantidad,
                usuario,
                referencia: `Ingreso de botellas por control interno ${numero} de ${servicio}`
            });
            // El control también mete botellas: salda solo los ajustes
            // pendientes de ese artículo que ahora alcanzan.
            saldadasServicio += await regularizarAjustesPendientes(client, {
                articuloId: ln.botella_id,
                articuloNombre: ln.producto,
                usuario,
                vinculoTipo: 'AJUSTE',
                vinculoRef: `CONTROL ${numero} (${servicio})`,
                referencia: `Ajuste pendiente saldado con control interno ${numero} de ${servicio}`
            });
            detalle.push(ln.etiqueta_id
                ? `${ln.producto} x ${ln.cantidad} (${ln.cantMill} MILLARES)`
                : `${ln.producto} x ${ln.cantidad}`);
        }
        const totalControl = lineas.reduce((s, l) => s + l.cantidad, 0);
        const resumenControl = lineas[0].producto + (lineas.length > 1 ? ` (+${lineas.length - 1})` : '');
        const cabControl = await client.query(
            `INSERT INTO servicios_guias (servicio, tipo_doc, numero, fecha, producto, producto_key,
                cantidad, botella_id, factura_estado, estado, usuario)
             VALUES ($1, 'CONTROL', $2, $3, $4, $5, $6, $7, 'PENDIENTE', 'PENDIENTE', $8)
             RETURNING id`,
            [servicio, numero, fecha, resumenControl, lineas[0].producto_key, totalControl, lineas[0].botella_id, usuario]
        );
        const controlId = cabControl.rows[0].id;
        for (const ln of lineas) {
            await client.query(
                `INSERT INTO servicios_guias_items (guia_id, producto, producto_key, cantidad,
                    etiqueta_id, etiqueta_nombre, cant_etiquetas,
                    preforma_id, preforma_nombre, cant_preformas, botella_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [controlId, ln.producto, ln.producto_key, ln.cantidad,
                 ln.etiqueta_id, ln.etiqueta_nombre, ln.cantMill,
                 ln.preforma_id, ln.preforma_nombre, ln.cantMill, ln.botella_id]
            );
        }
        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: `Control interno ${numero} registrado (pendiente de guía): ${totalControl} botellas en ${lineas.length} producto(s) sumadas al inventario: ${detalle.join('; ')}.`
                + (saldadasServicio ? ` Se saldaron ${saldadasServicio} ajuste(s) pendiente(s) con este ingreso.` : '')
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error en guía de servicio:', err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar: ' + err.message });
    } finally {
        client.release();
    }
});

// Vincular la factura de una guia de servicio.
app.post('/api/servicios/guias/:id/factura', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        const factura = String((req.body && req.body.factura_numero) || '').trim();
        if (!id || !factura) {
            return res.status(400).json({ success: false, mensaje: 'Guía y número de factura requeridos.' });
        }
        const upd = await client.query(
            `UPDATE servicios_guias SET factura_numero = $1, factura_estado = 'VINCULADA'
              WHERE id = $2 AND tipo_doc = 'GUIA'`,
            [factura, id]
        );
        if (upd.rowCount !== 1) {
            return res.status(404).json({ success: false, mensaje: 'La guía no existe.' });
        }
        res.json({ success: true, mensaje: `Factura ${factura} vinculada a la guía.` });
    } catch (err) {
        console.error('Error al vincular factura:', err);
        res.status(500).json({ success: false, mensaje: 'Error al vincular factura: ' + err.message });
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
            ORDER BY stock_cajas DESC, nombre_producto ASC
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
// Cada tipo de botella resuelve su nombre final y su etiqueta. La etiqueta
// NO se descuenta al soplar (salen en blanco): se descuenta al etiquetar.
// El artículo EN BLANCO es genérico por tamaño ("Botella 1 Lt (blanco)"):
// la marca la pone la etiqueta, y así una botella soplada sirve para la
// línea que tenga ese envase. El tamaño sale del molde puesto en la línea:
// molde de 800 ml → botella de 800 ml (se valida al registrar).
function mapaBotellaSoplado(botella_tipo) {
    let etiquetaNombre = null;
    let botellaNombre = '';
    let blancoNombre = '';
    let tamano = '';

    switch (botella_tipo) {
            // LÍNEA BELINI
            case 'soplado_belini_200ml':
                botellaNombre = 'Botella Belini x 200 ml';
                etiquetaNombre = 'Etiqueta couche 90 gr x 200 ml B-1';
                blancoNombre = 'Botella 200 ml (blanco)';
                tamano = '200ml';
                break;
            case 'soplado_belini_500ml':
                botellaNombre = 'Botella Belini x 500 ml';
                etiquetaNombre = 'Etiqueta couche 90 gr x 500 ml Belini';
                blancoNombre = 'Botella 500 ml (blanco)';
                tamano = '500ml';
                break;
            case 'soplado_belini_900ml':
                botellaNombre = 'Botella Belini x 900 ml';
                etiquetaNombre = 'Etiqueta couche 90 gr x 900 ml Belini';
                blancoNombre = 'Botella 900 ml (blanco)';
                tamano = '900ml';
                break;
            case 'soplado_belini_1lt':
                botellaNombre = 'Botella Belini x 1 Lt';
                etiquetaNombre = 'Etiqueta couche 90 gr x 1 lt Belini';
                blancoNombre = 'Botella 1 Lt (blanco)';
                tamano = '1lt';
                break;
            case 'soplado_belini_3lt':
                botellaNombre = 'Botella Belini x 3 lt';
                etiquetaNombre = 'Etiqueta polipropileno blanco x 3 lt Belini';
                blancoNombre = 'Botella 3 Lt (blanco)';
                tamano = '3lt';
                break;

            // LÍNEA B-1
            case 'soplado_b1_200ml':
                botellaNombre = 'Botella de 200 ml - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 200 ml B-1';
                blancoNombre = 'Botella 200 ml (blanco)';
                tamano = '200ml';
                break;
            case 'soplado_b1_500ml':
                botellaNombre = 'Botella de 500 ml - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 500 ml B-1';
                blancoNombre = 'Botella 500 ml (blanco)';
                tamano = '500ml';
                break;
            case 'soplado_b1_900ml':
                botellaNombre = 'Botella de 900 ml - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 900 ml B-1';
                blancoNombre = 'Botella 900 ml (blanco)';
                tamano = '900ml';
                break;
            case 'soplado_b1_1lt':
                botellaNombre = 'Botella de 1 Lt - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 1 lt B-1';
                blancoNombre = 'Botella 1 Lt (blanco)';
                tamano = '1lt';
                break;
            case 'soplado_b1_2lt':
                botellaNombre = 'Botella de 2 Lt - B-1';
                etiquetaNombre = 'Etiqueta couche 90 gr x 2 lt B-1';
                blancoNombre = 'Botella 2 Lt (blanco)';
                tamano = '2lt';
                break;

            // OTRAS MARCAS
            case 'soplado_donlalo_800ml':
                botellaNombre = 'Botella de 800ml - Don Lalo';
                etiquetaNombre = 'Etiqueta couche 90gr x 800 ml Don Lalo';
                blancoNombre = 'Botella 800 ml (blanco)';
                tamano = '800ml';
                break;
            case 'soplado_vega_900ml':
                botellaNombre = 'Botella VEGA x 900 ml';
                etiquetaNombre = null;
                blancoNombre = 'Botella 900 ml (blanco)';
                tamano = '900ml';
                break;
            default:
                throw new Error('Tipo de botella desconocido.');
        }
    return { botellaNombre, etiquetaNombre, blancoNombre, tamano };
}

// Tamaño canónico de un molde o tipo de botella: "Molde de 800 ml" o
// "soplado_donlalo_800ml" → "800ml". Vacío si el texto no trae tamaño
// (molde viejo escrito a mano).
function tamanoClaveBotella(txt) {
    const m = String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .match(/(\d+(?:[.,]\d+)?)\s*(ml|lt|l)\b/);
    if (!m) return '';
    return String(parseFloat(m[1].replace(',', '.'))) + (m[2] === 'ml' ? 'ml' : 'lt');
}

app.post('/api/soplado/registrar', gSoplado, async (req, res) => {
    const client = await pool.connect();
    try {
        const { preforma_nombre, botella_tipo, cantidad_producida, usuario, linea, molde } = req.body;
        // Etiquetada en el momento: la botella sale terminada (con su marca) y
        // se descuenta la etiqueta. Si no se reporta etiqueta, sale EN BLANCO
        // y se etiqueta luego con /api/soplado/etiquetar.
        const etiquetada = req.body.etiquetada === true || req.body.etiquetada === 'true';
        const cantidadBotellas = parseInt(cantidad_producida, 10);
        if (!cantidadBotellas || cantidadBotellas <= 0 || cantidadBotellas > 1000000) {
            return res.status(400).json({ success: false, mensaje: 'Cantidad producida inválida. Debe ser un número entero mayor a 0.' });
        }
        if (!preforma_nombre || !String(preforma_nombre).trim()) {
            return res.status(400).json({ success: false, mensaje: 'Debe seleccionar cuál preforma se usó.' });
        }
        // Dos líneas: automática y manual. Cada una trabaja con su molde.
        const lineaVal = String(linea || 'AUTOMATICA').trim().toUpperCase();
        if (!['AUTOMATICA', 'MANUAL'].includes(lineaVal)) {
            return res.status(400).json({ success: false, mensaje: 'Línea inválida (AUTOMATICA o MANUAL).' });
        }
        const moldeVal = String(molde || '').trim().slice(0, 100);

        // Sin la migración de líneas, el reporte se guarda como antes.
        let conLinea = true;
        try {
            const cols = await client.query(
                `SELECT column_name FROM information_schema.columns WHERE table_name = 'reportes_soplado'`
            );
            conLinea = cols.rows.some(r => r.column_name === 'linea');
        } catch (e) { conLinea = false; }

        await client.query('BEGIN');
        // Cada línea marcha por su cuenta: registrar en una línea exige que
        // ESA línea esté en marcha (sin fila registrada se permite, como antes).
        await exigirLineaEnMarcha(client, 'soplado_' + lineaVal.toLowerCase());

        const { botellaNombre, etiquetaNombre, blancoNombre, tamano } = mapaBotellaSoplado(botella_tipo);

        // El molde puesto en la línea define el tamaño de la botella: molde
        // de 800 ml → botella de 800 ml. Un molde viejo sin tamaño legible
        // no bloquea.
        const tamMolde = tamanoClaveBotella(moldeVal);
        if (tamMolde && tamano && tamMolde !== tamano) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                mensaje: `El molde "${moldeVal}" es de ${tamMolde} y la botella "${botellaNombre}" es de ${tamano}. Seleccione el molde que corresponde a esa botella.`
            });
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

        // 2. Destino de las botellas:
        //   • ETIQUETADA (el operador reportó la etiqueta que va en la botella):
        //     la botella sale TERMINADA con su marca y se descuenta la etiqueta
        //     aquí mismo. No pasa por el rubro en blanco.
        //   • SIN ETIQUETA: sale EN BLANCO y se etiqueta luego con
        //     /api/soplado/etiquetar.
        let saldadasSoplado = 0;
        let idTerminada = null;
        if (etiquetada) {
            if (!etiquetaNombre) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    mensaje: `La botella "${botellaNombre}" no tiene etiqueta configurada. Registrela sin etiqueta (en blanco).`
                });
            }
            // La etiqueta debe existir y alcanzar (stock en MILLARES).
            const etRow = await client.query(
                'SELECT id, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) FOR UPDATE',
                [etiquetaNombre]
            );
            if (!etRow.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `La etiqueta "${etiquetaNombre}" no existe en el inventario.` });
            }
            const cantMill = cantidadBotellas / 1000;
            const stockEtqAnterior = Number(etRow.rows[0].stock) || 0;
            if (stockEtqAnterior < cantMill) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    mensaje: `Alcanzan ${stockEtqAnterior} MILL de "${etiquetaNombre}" y se necesitan ${cantMill}. Registre la producción sin etiqueta (en blanco).`
                });
            }
            // La botella terminada debe existir en el inventario.
            const finRow = await client.query(
                'SELECT id, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1))',
                [botellaNombre]
            );
            if (!finRow.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `La botella terminada "${botellaNombre}" no existe en el inventario. Créala primero.` });
            }
            await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [cantMill, etRow.rows[0].id]);
            await actualizarEstadoArticulo(client, null, etRow.rows[0].id);
            await registrarHistorial(client, {
                tipo: 'PRODUCCION', origen: 'soplado',
                producto: etiquetaNombre,
                cantidad: cantMill, tipo_cambio: 'RESTA',
                stock_anterior: stockEtqAnterior, stock_nuevo: stockEtqAnterior - cantMill,
                usuario: usuarioResponsable(req, usuario),
                referencia: 'Etiqueta al soplar: ' + cantidadBotellas + ' uds de ' + botellaNombre
            });
            const stockFinAnterior = Number(finRow.rows[0].stock) || 0;
            await client.query('UPDATE inventario SET stock = stock + $1 WHERE id = $2', [cantidadBotellas, finRow.rows[0].id]);
            await actualizarEstadoArticulo(client, null, finRow.rows[0].id);
            await registrarHistorial(client, {
                tipo: 'PRODUCCION', origen: 'soplado',
                producto: botellaNombre, articulo_id: finRow.rows[0].id,
                cantidad: cantidadBotellas, tipo_cambio: 'SUMA',
                stock_anterior: stockFinAnterior, stock_nuevo: stockFinAnterior + cantidadBotellas,
                usuario: usuarioResponsable(req, usuario),
                referencia: 'Producción soplado etiquetada: ' + cantidadBotellas + ' uds ' + botellaNombre
            });
            // El artículo terminado que entró: es el que se usará para
            // regularizar los ajustes pendientes cuando ya exista el reporte.
            idTerminada = finRow.rows[0].id;
        } else {
            // Sin etiqueta reportada: sumar las botellas EN BLANCO a su
            // artículo. Se crea solo si no existe: es el pequeño inventario
            // de soplado.
            let blRow = await client.query(
                'SELECT id, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1))',
                [blancoNombre]
            );
            if (!blRow.rows.length) {
                blRow = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado)
                     VALUES ($1, $2, $3, $4, $5) RETURNING id, stock`,
                    [blancoNombre, 'BOTELLAS EN BLANCO', 0, 'UNIDADES', 'REALIZAR PEDIDO']
                );
            }
            const stockBlancoAnterior = Number(blRow.rows[0].stock) || 0;
            await client.query(
                'UPDATE inventario SET stock = stock + $1 WHERE id = $2',
                [cantidadBotellas, blRow.rows[0].id]
            );
            await actualizarEstadoArticulo(client, null, blRow.rows[0].id);
            await registrarHistorial(client, {
                tipo: 'PRODUCCION', origen: 'soplado',
                producto: blancoNombre, articulo_id: blRow.rows[0].id,
                cantidad: cantidadBotellas, tipo_cambio: 'SUMA',
                stock_anterior: stockBlancoAnterior, stock_nuevo: stockBlancoAnterior + cantidadBotellas,
                usuario: usuarioResponsable(req, usuario),
                referencia: 'Producción soplado en blanco: ' + cantidadBotellas + ' uds ' + blancoNombre
            });
        }

        // Guardar el reporte del día para la barra de estado y estadísticas.
        // Su id es el vínculo con el que se saldan los ajustes pendientes que
        // esta producción regulariza (se registra ya validado el destino).
        let reporteId = null;
        if (conLinea) {
            const rep = await client.query(
                `INSERT INTO reportes_soplado (preforma_nombre, botella_tipo, botella_nombre, cantidad_botellas, usuario_registro, linea, molde)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [preforma_nombre, botella_tipo, botellaNombre, cantidadBotellas, usuario || 'soplado_user', lineaVal, moldeVal || null]
            );
            reporteId = rep.rows[0] && rep.rows[0].id;
        } else {
            const rep = await client.query(
                `INSERT INTO reportes_soplado (preforma_nombre, botella_tipo, botella_nombre, cantidad_botellas, usuario_registro)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [preforma_nombre, botella_tipo, botellaNombre, cantidadBotellas, usuario || 'soplado_user']
            );
            reporteId = rep.rows[0] && rep.rows[0].id;
        }

        // Entraron botellas terminadas (etiquetadas): si envasado tenía un
        // ajuste pendiente de este artículo, se salda solo aquí contra este
        // reporte, sin que almacén tenga que vincularlo a mano.
        if (etiquetada && idTerminada) {
            saldadasSoplado = await regularizarAjustesPendientes(client, {
                articuloId: idTerminada,
                articuloNombre: botellaNombre,
                usuario: usuarioResponsable(req, usuario),
                vinculoTipo: 'SOPLADO',
                vinculoRef: reporteId ? `#${reporteId}` : 'soplado',
                referencia: `Ajuste pendiente saldado con reporte de soplado #${reporteId || 's/n'} (${cantidadBotellas} uds ${botellaNombre} etiquetadas)`
            });
        }

        await client.query('COMMIT');
        // La línea conserva el último molde con el que produjo. Fuera de la
        // transacción y tolerante: si la tabla aún no existe por migración
        // pendiente, el reporte igual quedó guardado.
        if (moldeVal) {
            try {
                await pool.query(
                    `UPDATE soplado_lineas SET molde_actual = $1, fecha_actualizacion = CURRENT_TIMESTAMP WHERE linea = $2`,
                    [moldeVal, lineaVal]
                );
            } catch (e) {
                if (!e || e.code !== '42P01') console.error('No se pudo guardar el molde de la línea:', e);
                else console.warn('soplado_lineas pendiente de migración: molde no memorizado.');
            }
        }
        const lineaTxt = lineaVal === 'AUTOMATICA' ? 'línea automática' : 'línea manual';
        const msgFinal = etiquetada
            ? `Producción de ${cantidadBotellas} unidades de ${botellaNombre} ETIQUETADA registrada en ${lineaTxt}${moldeVal ? ` (molde ${moldeVal})` : ''}. Se descontaron la preforma "${preforma_nombre}" y ${cantidadBotellas / 1000} MILL de la etiqueta "${etiquetaNombre}".`
            : `Producción de ${cantidadBotellas} unidades de ${botellaNombre} en blanco registrada en ${lineaTxt}${moldeVal ? ` (molde ${moldeVal})` : ''}. Se descontó la preforma "${preforma_nombre}". Las etiquetas se descuentan al etiquetar.`;
        const avisoSaldados = saldadasSoplado
            ? ` Se saldaron ${saldadasSoplado} ajuste(s) pendiente(s) de "${botellaNombre}" con esta producción.`
            : '';
        res.json({ success: true, mensaje: msgFinal + avisoSaldados });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al registrar soplado:', error);
        res.status(error.status || 500).json({ success: false, mensaje: (error.status ? '' : 'Error al procesar el reporte de soplado: ') + error.message });
    } finally {
        client.release();
    }
});

// --- SOPLADO: etiquetar botellas en blanco. Descuenta las botellas en
// blanco y sus etiquetas (en MILL), y suma las botellas terminadas. Es el
// paso que lleva lo soplado a producción.
app.post('/api/soplado/etiquetar', gSoplado, async (req, res) => {
    const client = await pool.connect();
    try {
        const { botella_tipo, cantidad, linea, usuario } = req.body;
        const cant = parseInt(cantidad, 10);
        if (!cant || cant <= 0 || cant > 1000000) {
            return res.status(400).json({ success: false, mensaje: 'Cantidad inválida. Debe ser un número entero mayor a 0.' });
        }
        const lineaVal = String(linea || 'AUTOMATICA').trim().toUpperCase();
        if (!['AUTOMATICA', 'MANUAL'].includes(lineaVal)) {
            return res.status(400).json({ success: false, mensaje: 'Línea inválida (AUTOMATICA o MANUAL).' });
        }
        await client.query('BEGIN');
        await exigirLineaEnMarcha(client, 'soplado_' + lineaVal.toLowerCase());
        let mapa;
        try {
            mapa = mapaBotellaSoplado(botella_tipo);
        } catch (e) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Tipo de botella desconocido.' });
        }
        const { botellaNombre, etiquetaNombre, blancoNombre } = mapa;

        const blRow = await client.query(
            'SELECT id, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) FOR UPDATE',
            [blancoNombre]
        );
        if (!blRow.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `Aún no hay "${blancoNombre}" en blanco. Registra primero la producción de soplado.` });
        }
        const stockBlanco = Number(blRow.rows[0].stock) || 0;
        if (stockBlanco < cant) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `Solo hay ${stockBlanco} en blanco de "${botellaNombre}".` });
        }
        const finRow = await client.query(
            'SELECT id, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) FOR UPDATE',
            [botellaNombre]
        );
        if (!finRow.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `La botella terminada "${botellaNombre}" no existe en el inventario. Créala primero.` });
        }
        let stockEtq = null;
        let cantMill = 0;
        if (etiquetaNombre) {
            const etRow = await client.query(
                'SELECT id, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) FOR UPDATE',
                [etiquetaNombre]
            );
            if (!etRow.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `La etiqueta "${etiquetaNombre}" no existe en el inventario.` });
            }
            stockEtq = { id: etRow.rows[0].id, nombre: etiquetaNombre, anterior: Number(etRow.rows[0].stock) || 0 };
            cantMill = cant / 1000;
        }

        const quien = usuarioResponsable(req, usuario);
        const lineaTxt = lineaVal === 'AUTOMATICA' ? 'línea automática' : 'línea manual';
        await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [cant, blRow.rows[0].id]);
        await actualizarEstadoArticulo(client, null, blRow.rows[0].id);
        await registrarHistorial(client, {
            tipo: 'PRODUCCION', origen: 'soplado_etiquetado',
            producto: blancoNombre, articulo_id: blRow.rows[0].id,
            cantidad: cant, tipo_cambio: 'RESTA',
            stock_anterior: stockBlanco, stock_nuevo: stockBlanco - cant,
            usuario: quien,
            referencia: `Etiquetado en ${lineaTxt}: ${cant} uds ${botellaNombre}`
        });
        if (stockEtq) {
            await client.query('UPDATE inventario SET stock = stock - $1 WHERE id = $2', [cantMill, stockEtq.id]);
            await actualizarEstadoArticulo(client, null, stockEtq.id);
            await registrarHistorial(client, {
                tipo: 'PRODUCCION', origen: 'soplado_etiquetado',
                producto: stockEtq.nombre,
                cantidad: cantMill, tipo_cambio: 'RESTA',
                stock_anterior: stockEtq.anterior, stock_nuevo: stockEtq.anterior - cantMill,
                usuario: quien,
                referencia: `Etiquetado en ${lineaTxt}: ${cant} uds ${botellaNombre}`
            });
        }
        const stockFin = Number(finRow.rows[0].stock) || 0;
        await client.query('UPDATE inventario SET stock = stock + $1 WHERE id = $2', [cant, finRow.rows[0].id]);
        await actualizarEstadoArticulo(client, null, finRow.rows[0].id);
        await registrarHistorial(client, {
            tipo: 'PRODUCCION', origen: 'soplado_etiquetado',
            producto: botellaNombre, articulo_id: finRow.rows[0].id,
            cantidad: cant, tipo_cambio: 'SUMA',
            stock_anterior: stockFin, stock_nuevo: stockFin + cant,
            usuario: quien,
            referencia: `Etiquetado en ${lineaTxt}: ${cant} uds ${botellaNombre}`
        });
        // Entraron botellas terminadas: salda solo los ajustes pendientes
        // de este artículo que ahora alcanzan.
        const saldadasEtiquetado = await regularizarAjustesPendientes(client, {
            articuloId: finRow.rows[0].id,
            articuloNombre: botellaNombre,
            usuario: quien,
            vinculoTipo: 'SOPLADO',
            vinculoRef: `ETIQUETADO ${lineaVal}`,
            referencia: `Ajuste pendiente saldado con etiquetado en ${lineaTxt} (${cant} uds ${botellaNombre})`
        });

        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: `Etiquetadas ${cant} de "${botellaNombre}" en ${lineaTxt}: se descontaron ${cant} en blanco` +
                (stockEtq ? ` y ${cantMill} MILL de "${etiquetaNombre}"` : ' (sin etiqueta)') + '.'
                + (saldadasEtiquetado ? ` Se saldaron ${saldadasEtiquetado} ajuste(s) pendiente(s) de "${botellaNombre}".` : '')
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al etiquetar:', error);
        res.status(error.status || 500).json({ success: false, mensaje: (error.status ? '' : 'Error al etiquetar: ') + error.message });
    } finally {
        client.release();
    }
});

app.get('/api/soplado/reportes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reportes_soplado ORDER BY id DESC LIMIT 500');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Molde actual de cada línea de soplado (automática y manual).
app.get('/api/soplado/lineas', async (req, res) => {
    try {
        const result = await pool.query('SELECT linea, nombre, molde_actual FROM soplado_lineas ORDER BY linea ASC');
        res.json({ success: true, lineas: result.rows });
    } catch (err) {
        if (err && err.code === '42P01') {
            return res.json({ success: true, migracionPendiente: true, lineas: [] });
        }
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
        // Soplado tiene dos líneas independientes que marchan a la vez.
        const areaValida = area === 'envasado' || area === 'soplado' || area === 'soplado_automatica' || area === 'soplado_manual';
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
                proximo_producto = CASE
                    WHEN EXCLUDED.estado = 'PARADO' THEN NULL
                    WHEN $5 THEN EXCLUDED.proximo_producto
                    ELSE estado_lineas.proximo_producto END`,
            [area, estado, usuario || 'operador', tieneSiguiente ? proximo_producto : null, tieneSiguiente]
        );
        // Parar la linea deja todo a cero: sin produccion no hay "siguiente".
        // Sin esto la cola vieja seguia apareciendo en el dashboard como SIGUIENTE.
        if (estado === 'PARADO' && AREAS_CON_PLAN.includes(area)) {
            await pool.query('DELETE FROM linea_plan WHERE area = $1', [area]);
        }
        res.json({ success: true, area, estado, proximo_producto: tieneSiguiente ? proximo_producto : undefined });
    } catch (err) {
        console.error('Error al actualizar estado de línea:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- PLAN DE PRODUCCIÓN POR LÍNEA ---
// La secuencia de productos que la línea va a producir: el de orden 1 es el que
// está en curso, los siguientes son los que le siguen.
//
// Esto reemplaza a estado_lineas.proximo_producto, que era texto libre y solo
// guardaba un producto. Ahí era fácil que el dashboard mostrara un producto que
// no existía: el nombre no se comprobaba contra nada. Ahora cada clave de la
// secuencia tiene que ser una receta vigente, y una receta desactivada se ve
// como tal en vez de dejar un producto fantasma en pantalla.

// El plan de produccion solo aplica a envasado. Soplado fabrica el envase
// (botellas y preformas), no un producto terminado: esas piezas viven en el
// inventario como insumos y no tienen receta, asi que no hay catalogo contra el
// cual validar una secuencia. Por eso la linea de soplado solo publica su estado.
const AREAS_CON_PLAN = ['envasado'];

app.get('/api/linea-plan', async (req, res) => {
    try {
        // LEFT JOIN a proposito: si la receta se desactiva, la fila del plan
        // sigue existiendo (el operario no pierde la cola) pero se marca como
        // huerfana para que el dashboard no la presente como producto real.
        const result = await pool.query(`
            SELECT p.area,
                   p.orden,
                   p.producto_key,
                   p.usuario_registro,
                   p.fecha_actualizacion,
                   r.nombre_producto,
                   (r.producto_key IS NULL) AS receta_huerfana
            FROM linea_plan p
            LEFT JOIN LATERAL (
                SELECT rec.producto_key, rec.nombre_producto
                FROM recetas rec
                WHERE rec.producto_key = p.producto_key
                  AND rec.activa IS TRUE
                ORDER BY rec.version DESC
                LIMIT 1
            ) r ON true
            ORDER BY p.area, p.orden`);

        // La forma de la respuesta no cambia aunque soplado no tenga secuencia:
        // el dashboard lee siempre las mismas dos claves.
        const plan = { envasado: [], soplado: [] };
        result.rows.forEach(f => {
            if (!plan[f.area]) return;
            plan[f.area].push({
                orden: f.orden,
                producto_key: f.producto_key,
                nombre_producto: f.nombre_producto,
                receta_huerfana: Boolean(f.receta_huerfana),
                usuario_registro: f.usuario_registro,
                fecha_actualizacion: f.fecha_actualizacion
            });
        });
        res.json(plan);
    } catch (err) {
        console.error('Error al leer el plan de línea:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Resuelve lo que manda el editor de secuencia a una clave de receta
// vigente: acepta la clave tal cual, el nombre de catalogo fijo
// ("Aceite de Soya B-1 1 Lt" -> "b1_1lt") o el nombre de la receta.
// Devuelve '' si no hay receta vigente para esa entrada.
async function resolverClaveSecuencia(client, entrada) {
    const txt = String(entrada || '').trim();
    if (!txt) return '';
    let r = await client.query(
        `SELECT producto_key FROM recetas WHERE activa IS TRUE AND producto_key = $1 LIMIT 1`,
        [txt]
    );
    if (r.rows.length) return r.rows[0].producto_key;
    const directa = detectarProductoTipo(txt);
    if (directa) {
        r = await client.query(
            `SELECT producto_key FROM recetas WHERE activa IS TRUE AND producto_key = $1 LIMIT 1`,
            [directa]
        );
        if (r.rows.length) return r.rows[0].producto_key;
    }
    r = await client.query(
        `SELECT producto_key FROM recetas
          WHERE activa IS TRUE AND (nombre_producto ILIKE $1 OR producto_key ILIKE $1)
          ORDER BY version DESC LIMIT 1`,
        [txt]
    );
    return r.rows.length ? r.rows[0].producto_key : '';
}

app.post('/api/linea-plan', gEnvasado, async (req, res) => {
    const client = await pool.connect();
    try {
        const { area, productos, usuario } = req.body;
        if (!AREAS_CON_PLAN.includes(area)) {
            return res.status(400).json({
                success: false,
                mensaje: area === 'soplado'
                    ? 'La línea de soplado no maneja secuencia: produce el envase, no un producto terminado.'
                    : 'Área inválida.'
            });
        }
        if (!Array.isArray(productos)) {
            return res.status(400).json({ success: false, mensaje: 'La lista de productos debe ser un arreglo.' });
        }
        if (productos.length > 50) {
            return res.status(400).json({ success: false, mensaje: 'La secuencia no puede tener más de 50 productos.' });
        }

        const claves = productos.map(p => String(p == null ? '' : p).trim()).filter(Boolean);
        if (new Set(claves).size !== claves.length) {
            return res.status(400).json({
                success: false,
                mensaje: 'El mismo producto no puede repetirse en la secuencia.'
            });
        }

        // El editor manda a veces el nombre visible ("Aceite de Soya B-1 1 Lt")
        // y no la clave ("b1_1lt"): se resuelve a la clave vigente antes de
        // validar, para no rechazar secuencias correctas. Lo que no resuelve
        // a ninguna receta vigente se rechaza entero, para que la linea no se
        // quede con media cola guardada.
        const resueltas = [];
        const desconocidas = [];
        for (const cruda of claves) {
            const clave = await resolverClaveSecuencia(client, cruda);
            if (clave) resueltas.push(clave);
            else desconocidas.push(cruda);
        }
        if (desconocidas.length) {
            return res.status(400).json({
                success: false,
                mensaje: 'Hay productos en la secuencia que no tienen receta vigente. Revísalos antes de guardar.',
                detalle: desconocidas
            });
        }
        if (new Set(resueltas).size !== resueltas.length) {
            return res.status(400).json({
                success: false,
                mensaje: 'El mismo producto no puede repetirse en la secuencia.'
            });
        }

        await client.query('BEGIN');
        // Se reemplaza la cola completa en vez de editarla fila por fila: una
        // reordenacion parcial deja huecos que rompen el "orden 1 = en curso".
        await client.query('DELETE FROM linea_plan WHERE area = $1', [area]);
        for (let i = 0; i < resueltas.length; i++) {
            await client.query(
                `INSERT INTO linea_plan (area, orden, producto_key, usuario_registro, fecha_actualizacion)
                 VALUES ($1, $2, $3, $4, (now() at time zone 'utc'))`,
                [area, i + 1, resueltas[i], usuario || 'operador']
            );
        }
        await client.query('COMMIT');

        res.json({ success: true, area, total: resueltas.length });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al guardar el plan de línea:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    } finally {
        client.release();
    }
});

// --- FUNCIÓN AUXILIAR: AUTO-REGULARIZAR AJUSTES PENDIENTES ---
// Cuando entra stock de un artículo (soplado etiquetado, etiquetado, guía o
// control de servicio, ingreso de almacén), los ajustes PENDIENTES de ese
// artículo que ahora alcanzan se saldan solos dentro de la MISMA transacción:
// descuenta el stock, deja el rastro en el historial y marca el pendiente
// APLICADA con su vínculo. Es el mismo camino que el aplicar manual, para que
// almacén no tenga que vincular a mano lo que el reporte/guía ya trajo.
//
// Reglas:
//  • No deja stock negativo: si el pendiente no alcanza, se salta (queda
//    PENDIENTE hasta que entre más), igual que hace el aplicar manual.
//  • Bloquea los pendientes (FOR UPDATE) ordenados por id para que dos
//    entradas simultáneas del mismo artículo no lo salden dos veces.
//  • Si el artículo todavía no existe en inventario no hace nada: el
//    pendiente sigue esperando a que lo creen.
// Devuelve cuántos pendientes saldó.
async function regularizarAjustesPendientes(q, opciones) {
    const articuloId = opciones && opciones.articuloId ? parseInt(opciones.articuloId, 10) : null;
    const articuloNombre = String((opciones && opciones.articuloNombre) || '').trim();
    const usuario = (opciones && opciones.usuario) || 'sistema';
    const vinculoTipo = String((opciones && opciones.vinculoTipo) || 'AJUSTE').trim().toUpperCase();
    const vinculoRef = String((opciones && opciones.vinculoRef) || 'AUTOMÁTICO').trim();
    if (!articuloId && !articuloNombre) return 0;

    const pend = await q.query(
        `SELECT id, cantidad_pendiente FROM ajustes_pendientes
          WHERE estado = 'PENDIENTE'
            AND (($1::int IS NOT NULL AND articulo_id = $1)
              OR ($2 <> '' AND articulo_id IS NULL AND LOWER(BTRIM(articulo_nombre)) = LOWER(BTRIM($2))))
          ORDER BY id ASC
          FOR UPDATE`,
        [articuloId, articuloNombre]
    );
    if (!pend.rows.length) return 0;

    // El artículo se resuelve por id o, si el pendiente se creó sin id, por
    // su nombre exacto (mismo criterio del aplicar manual).
    let idFinal = articuloId;
    let nombreFinal = articuloNombre;
    const st = idFinal
        ? await q.query('SELECT id, nombre, stock FROM inventario WHERE id = $1 FOR UPDATE', [idFinal])
        : await q.query(
            'SELECT id, nombre, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) FOR UPDATE',
            [nombreFinal]
        );
    if (!st.rows.length) return 0;
    idFinal = st.rows[0].id;
    nombreFinal = st.rows[0].nombre;

    let stock = Number(st.rows[0].stock) || 0;
    let saldados = 0;
    for (const p of pend.rows) {
        const debe = Number(p.cantidad_pendiente) || 0;
        if (!(debe > 0) || stock < debe) continue;
        const desc = await q.query(
            'UPDATE inventario SET stock = stock - $1 WHERE id = $2 RETURNING stock',
            [debe, idFinal]
        );
        if (desc.rowCount !== 1) continue;
        stock = Number(desc.rows[0].stock);
        await actualizarEstadoArticulo(q, nombreFinal, idFinal);
        await registrarHistorial(q, {
            tipo: 'SALIDA', origen: 'ajuste_pendiente',
            producto: nombreFinal, articulo_id: idFinal,
            cantidad: debe, tipo_cambio: 'RESTA',
            stock_anterior: stock + debe, stock_nuevo: stock,
            usuario,
            referencia: (opciones && opciones.referencia)
                || `Ajuste pendiente saldado automáticamente con ${vinculoTipo} ${vinculoRef}`
        });
        await q.query(
            `UPDATE ajustes_pendientes
                SET estado = 'APLICADA', cantidad_aplicada = $1,
                    vinculo_tipo = $2, vinculo_ref = $3,
                    aplicado_por = $4, fecha_aplicacion = CURRENT_TIMESTAMP
              WHERE id = $5`,
            [debe, vinculoTipo, vinculoRef, usuario, p.id]
        );
        saldados += 1;
    }
    return saldados;
}

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

// --- LÍNEA EN MARCHA: condición para registrar producción ---
// `estado_lineas` se escribía y se pintaba en pantalla, pero ninguna ruta de
// producción la consultaba: una línea en PARADO seguía Laplacando y sumando
// producto terminado, y el indicador no describía nada real. Ahora la consulta
// bloquea el registro, que es lo que el operario espera al ver "PARADO".
//
// Si el área no tiene fila se deja pasar. La tabla se puebla desde la propia
// pantalla y no toda planta la tiene configurada para las dos áreas; bloquear
// por una fila que nunca se creó dejaría la planta sin poder producir.
async function exigirLineaEnMarcha(client, area) {
    const r = await client.query('SELECT estado FROM estado_lineas WHERE area = $1', [area]);
    if (!r.rows.length) return;
    const estado = String(r.rows[0].estado || '').trim().toUpperCase();
    if (estado === 'EN MARCHA') return;
    const nombre = area === 'soplado_automatica' ? 'línea automática de soplado'
      : area === 'soplado_manual' ? 'línea manual de soplado'
      : 'línea de ' + area;
    const err = new Error(
        `La ${nombre} está ${estado || 'sin estado registrado'}. Ponla en marcha antes de registrar producción.`
    );
    err.status = 409;
    throw err;
}

// --- FUNCIÓN AUXILIAR: HISTORIAL DE MOVIMIENTOS DE INVENTARIO ---
// La auditoría es obligatoria: si el movimiento de stock no queda registrado,
// el error sube y la transacción que lo llamó se revierte. Un stock movido sin
// rastro es indistinguible de un stock inventado.
//
// No hay modo best-effort. Antes `tolerable: true` permitia tragarse el fallo
// del INSERT; eso dejaba el stock movido y sin auditoria, y era el unico punto
// donde refinado se movia sin dejar rastro. Si una vez mas hiciera falta, el
// movimiento tiene que ser reversible por transaccion, no silencioso.
/**
 * Registra el movimiento. No captura el error a proposito: la exception sube a la
 * transaccion que la llamo y esa revierte el stock, de modo que el inventario nunca
 * queda movido sin la fila que lo justifica.
 */
async function registrarHistorial(q, datos) {
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
// Miles y decimales estilo guía SUNAT/OCR: "9,775.000" → 9775,
// "150.00" → 150, "150,00" → 150. Un punto con exactamente 3 decimales
// suelto ("9.775") se lee como miles: las cantidades de guía en toneladas
// traen su unidad (TM/KG) y se resuelven aparte.
function parseNumeroGuia(s) {
    let t = String(s || '').trim();
    if (!/^\d[\d.,]*$/.test(t)) return null;
    const tieneComa = t.includes(',');
    const tienePunto = t.includes('.');
    if (tieneComa && tienePunto) {
        if (t.lastIndexOf('.') > t.lastIndexOf(',')) t = t.replace(/,/g, '');
        else t = t.replace(/\./g, '').replace(',', '.');
    } else if (tieneComa) {
        t = /,\d{3}$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    } else if (/^\d+\.\d{3}$/.test(t)) {
        t = t.replace(/\./g, '');
    }
    const v = Number(t);
    if (!Number.isFinite(v) || v <= 0 || v >= 100000) return null;
    return Math.round(v * 100) / 100;
}

// Orden de compra declarada en la guía ("ORDEN DE COMPRA : 0374-2026",
// "Orden de Compra : 434-2026", "OC:60-2026"). Sirve para prellenar y
// validar la OC en el ingreso a almacén.
function extraerOrdenCompra(textoPdf) {
    let m = textoPdf.match(/Orden de Compra\s*:?\s*([A-Z0-9][A-Z0-9-]{1,19})/i);
    if (m) return m[1].trim();
    m = textoPdf.match(/(?:^|\n)\s*OC\s*:\s*([A-Z0-9][A-Z0-9-]{1,19})/im);
    if (m) return m[1].trim();
    return '';
}

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

// Nombre de artículo en forma plana (sin acentos, espacios ni puntuación).
// Es el mismo matching que usa el asistente de almacén: "Tapa balde belini
// 18lt" y "TAPA BALDE BELINI 18-LT" son el mismo artículo, y si no empata
// ninguno el producto es nuevo y exige categoría del que lo registra.
function normalizarNombreInventario(txt) {
    return String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Claves de matching de un nombre: la plana y la que ignora la "x" de
// presentación ("Balde Belini x 18 lt" y "BALDE BELINI 18 LT" son el mismo
// artículo; sin esto la guía creaba un duplicado en General).
function variantesNombreInventario(txt) {
    const base = normalizarNombreInventario(txt);
    const sinX = String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9]+/)
        .filter(t => t && t !== 'x')
        .join('');
    if (!base) return [];
    return base === sinX ? [base] : [base, sinX];
}

// Tokens de un nombre para matching por CONTENIDO: minúsculas, sin acentos,
// "1lt" se parte en "1"+"lt", se ignora la "x" de presentación y los plurales
// se singularizan ("etiquetas"→"etiqueta"). Así "Etiquetas b-1 1lt" y
// "Etiqueta couche 90 gr x 1 lt B-1" comparten (casi) todo su vocabulario
// aunque la guía omita el material ("couche 90 gr").
function tokensArticulo(txt) {
    return String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/([0-9])([a-z])/g, '$1 $2')
        .replace(/([a-z])([0-9])/g, '$1 $2')
        .split(/[^a-z0-9]+/).filter(Boolean)
        .filter(t => t !== 'x')
        .map(t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
        // El código de envase "B-1" queda como par (b,1) tras el reparto de
        // arriba; se vuelve a juntar como "b1". Sin esto el "1" de "B-1" se
        // confunde con el "1" de la medida "1 lt" y no se puede distinguir un
        // envase B-1 de un B-2.
        .reduce((acc, t, i, arr) => {
            const prev = arr[i - 1];
            if (prev && /^[a-z]$/.test(prev) && /^\d+$/.test(t)) {
                acc[acc.length - 1] = prev + t;
                return acc;
            }
            acc.push(t);
            return acc;
        }, []);
}

// Un número SUELTO no sirve para comparar: en "B-1" el "1" es el código del
// envase, en "1 lt" es la medida, y "18 lt" reparte su tamaño entre dos tokens.
// Lo fiable es el PAR consecutivo número+unidad que deja el tokenizado: "1lt"
// y "1 lt" ambos producen ("1","lt"), y "800ml" produce ("800","ml"). Si la
// guía trae ("1","lt") y la ficha ("2","lt"), son tamaños distintos aunque el
// resto de las palabras coincida.
function medidasEn(toks) {
    const unidades = new Set(['ml', 'lt', 'gr', 'kg', 'mt', 'cc', 'mt2']);
    const out = [];
    for (let i = 0; i < toks.length - 1; i++) {
        if (/^\d+$/.test(toks[i]) && unidades.has(toks[i + 1])) {
            out.push(toks[i] + toks[i + 1]);
            i++; // la unidad ya se consumió
        }
    }
    return out;
}

// true si la guía y la ficha traen medida y ninguna coincide: son tamaños
// distintos. Requiere medida en AMBOS lados; con un solo lado no hay nada con
// qué comparar y se deja pasar (así "Preforma 5 lt" no descarta etiquetas).
function conflictoEnMedida(guia, cat) {
    const g = medidasEn(guia);
    const c = medidasEn(cat);
    if (!g.length || !c.length) return false;
    const setCat = new Set(c);
    return !g.some(t => setCat.has(t));
}

// true si la guía y la ficha traen código de envase (b1, b2, ...) y ninguno
// coincide. A diferencia de la medida, esto no es "si o si": un B-2 de la
// guía puede perfectamente apuntar a la ficha "Botella de 1 Lt - B-2", así que
// solo sirve como señal de desempate y no como veto absoluto.
function codigosEnvase(toks) {
    return toks.filter(t => /^[a-z]\d+$/.test(t));
}

function conflictoEnEnvase(guia, cat) {
    const g = codigosEnvase(guia);
    const c = codigosEnvase(cat);
    if (!g.length || !c.length) return false;
    const setCat = new Set(c);
    return !g.some(t => setCat.has(t));
}

// Resuelve un nombre de guía/operario contra el inventario en 3 capas:
// 1) igual exacto, 2) plano sin puntuación ni "x", 3) contenido de tokens con
// UN SOLO candidato (si hay varios no se adivina: se devuelven para elegir).
// Devuelve { tipo, articulo, candidatos }: tipo 'exacta' | 'variante' |
// 'similar' | 'ninguna' | 'ambigua'. Solo 'exacta'/'variante'/'similar' traen
// articulo; solo 'ambigua' trae candidatos.
async function resolverArticuloPorNombre(db, nombre) {
    const texto = String(nombre || '').trim();
    if (!texto) return { tipo: 'ninguna', articulo: null, candidatos: [] };

    const exacto = await db.query(
        'SELECT id, nombre, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) LIMIT 1',
        [texto]
    );
    if (exacto.rows.length) {
        return { tipo: 'exacta', articulo: exacto.rows[0], candidatos: [] };
    }

    const claves = new Set(variantesNombreInventario(texto));
    const toks = tokensArticulo(texto);
    if (!claves.size && !toks.length) return { tipo: 'ninguna', articulo: null, candidatos: [] };

    const todos = await db.query('SELECT id, nombre, stock FROM inventario');
    const porVariante = [];
    const porTokens = [];
    for (const fila of todos.rows) {
        if (claves.size && variantesNombreInventario(fila.nombre).some(k => claves.has(k))) {
            porVariante.push(fila);
            continue;
        }
        if (toks.length) {
            const ft = tokensArticulo(fila.nombre);
            if (!ft.length) continue;
            // El conflicto de medida descarta por sí solo: si la guía dice "1lt"
            // y la ficha "2 lt", son tamaños distintos aunque el resto de las
            // palabras coincida. Sin eso, "BOTELLAS 1Lt b-1" empatava con
            // "Botella de 2 Lt - B-1" (solo fallaba en el "2") y el operario
            // veía un 409 con un candidato que nunca fue el suyo.
            // El código de envase NO veta (un "b-2" de la guía puede apuntar a
            // la ficha "Botella de 1 Lt - B-2"); solo desempata: si la guía
            // trae "b-1", el B-1 queda por delante del B-2 de igual medida.
            if (conflictoEnMedida(toks, ft)) continue;
            const setCat = new Set(ft);
            const cuantos = toks.filter(t => setCat.has(t)).length;
            if (cuantos > 0) {
                porTokens.push({
                    fila,
                    cobertura: cuantos / ft.length,
                    envase: conflictoEnEnvase(toks, ft) ? 0 : 1
                });
            }
        }
    }
    // La variante plana manda sobre la similitud por tokens: es más estricta.
    if (porVariante.length === 1) {
        return { tipo: 'variante', articulo: porVariante[0], candidatos: [] };
    }
    if (porVariante.length > 1) {
        return { tipo: 'ambigua', articulo: null, candidatos: porVariante };
    }
    // De los que compartieron al menos un token, manda primero el código de
    // envase (b1/b2) y solo después la cobertura de tokens. Con dos señales
    // iguales no se adivina: se devuelven para elegir. Así "botellas 1lt b-2"
    // cae en el B-2 aunque el B-1 tenga la misma medida.
    if (porTokens.length) {
        const cmp = (a, b) => (b.envase - a.envase) || (b.cobertura - a.cobertura);
        const orden = [...porTokens].sort(cmp);
        if (orden.length === 1 || cmp(orden[0], orden[1]) < 0) {
            return { tipo: 'similar', articulo: orden[0].fila, candidatos: [] };
        }
        return { tipo: 'ambigua', articulo: null, candidatos: orden.map(c => c.fila) };
    }
    return { tipo: 'ninguna', articulo: null, candidatos: [] };
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
// cantidad pedida. Primero se borra el alias del producto, luego la
// presentación ("X 12 UND", "X 12 CAJA") y solo después se busca la cantidad:
// pegada a su unidad ("MLL 150.00", "9,775.000 UND") o, si no hay unidad, la
// última cifra. Si no queda ninguna cifra se devuelve null (y el item queda
// para revisión manual) en vez de inventar un número.
//
// Si la tabla trae columna PESO después de CANTIDAD y aun así quedan varias
// cifras sueltas, se toma la penúltima: la última es el peso, no lo pedido.
const UNID_CANT = 'MLL|MILL|MILLARES|UND|UNI|UNIDADES?|UN|CAJAS?|CJ';
function extraerCantidadFila(linea, alias, tomaPenultimo) {
    const reAlias = regexDesdeAlias(alias);
    let resto = reAlias ? linea.replace(reAlias, ' ') : linea;
    resto = resto.replace(new RegExp('\\bX\\s*\\d+\\s*(?:' + UNID_CANT + ')\\b', 'i'), ' ');
    const tm = /\b(TM|TON(?:ELADAS?)?|KG|KGM)\b/i.test(resto);
    const num = n => (tm && /^\d+\.\d{3}$/.test(n) ? Number(n) : parseNumeroGuia(n));
    const avisos = [];
    let m = resto.match(new RegExp('(' + UNID_CANT + ')\\s*(\\d[\\d.,]*)', 'i'));
    if (m) {
        const valor = num(m[2]);
        if (valor !== null) {
            const sobran = resto.replace(m[0], ' ').match(/\d[\d.,]*/g) || [];
            if (sobran.some(x => num(x) !== null)) {
                avisos.push(`La fila "${linea.slice(0, 60)}" trae más cifras además de la cantidad; se tomó ${valor}. Revísala.`);
            }
            return { valor, avisos };
        }
    }
    m = resto.match(new RegExp('(\\d[\\d.,]*)\\s*(' + UNID_CANT + ')\\b', 'i'));
    if (m) {
        const despues = resto.slice(m.index + m[0].length);
        if (!/\d+[.,]\d+/.test(despues)) {
            const valor = num(m[1]);
            if (valor !== null) return { valor, avisos };
        }
    }
    const numeros = (resto.match(/\d[\d.,]*/g) || [])
        .map(num)
        .filter(v => v !== null && v > 0 && v < 100000);
    if (numeros.length === 0) return { valor: null, avisos: [] };
    let valor = numeros[numeros.length - 1];
    if (tomaPenultimo && numeros.length > 1) {
        valor = numeros[numeros.length - 2];
        avisos.push(`La fila "${linea.slice(0, 60)}" trae columna PESO: se tomó ${valor} (cantidad) y no ${numeros[numeros.length - 1]} (peso). Revísala.`);
    } else if (numeros.length > 1) {
        avisos.push(`La fila "${linea.slice(0, 60)}" tiene varias cifras (${numeros.join(', ')}); se tomó la última como cantidad. Revísala.`);
    }
    return { valor, avisos };
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
    { product_key: 'belini_balde18lt', nombres: ['BELINI BALDE 18 LT', 'BELINI BALDE X 18 L', 'BELINI BALDE X 18 LT'] },
    { product_key: 'vega_900ml', nombres: ['VEGA X 900 ML', 'VEGA 900ML', 'VEGA 900 ML'] },
    { product_key: 'timonel_900ml', nombres: ['TIMONEL X 900 ML', 'TIMONEL 900ML', 'TIMONEL 900 ML'] },
    { product_key: 'fernandez_1lt', nombres: ['FERNANDEZ X 1 LT', 'FERNANDEZ 1 LT', 'FERNANDEZ 1L', 'FERNANDEZ X 1 L'] },
    { product_key: 'faisan_900ml', nombres: ['FAISAN X 900 ML', 'FAISAN 900ML', 'FAISAN 900 ML'] }
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
    // Si la tabla trae columna PESO tras CANTIDAD, la última cifra es el peso.
    const tablaConPeso = region.some(l => /cant/i.test(l) && /peso/i.test(l));

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
        const { valor: cantidad, avisos } = extraerCantidadFila(linea, alias, tablaConPeso);
        items.push({ product_key: prod.product_key, nombre, cantidad, cantidad_auto: cantidad !== null });
        if (cantidad === null) {
            advertencias.push(`Se detectó "${nombre}" en el PDF sin una cantidad clara. Revísala en la lista.`);
        }
        advertencias.push(...avisos);
    }
    return { items, advertencias };
}

// La IA devuelve nombres y cantidades pero no conoce nuestras claves
// internas (product_key) ni ids: se resuelven aquí con los mismos alias del
// lector local, luego catálogo de producto terminado y luego inventario.
// Solo igualdad normalizada: un parecido no vincula (para eso está el
// selector manual de la lista). Devuelve { product_key } o { articulo_id }.
//
// El nombre debe venir COMPLETO (marca + presentación, p. ej. "ACEITE DE SOYA
// B-1 X 1LT"): sin la presentación no hay con qué decidir entre tamaños y se
// devuelve null, en vez de adivinar y descontar el envase equivocado.
function resolverItemGuia(nombre, pts, invs) {
    const texto = normalizarGuia(nombre || '');
    if (!texto) return null;
    for (const p of PRODUCTOS_PDF_KEYWORDS) {
        if ((p.nombres || []).some(n => texto.includes(normalizarGuia(n)))) {
            return { product_key: p.product_key };
        }
    }
    const sinMarca = texto.replace(/aceitedesoya/g, '');
    for (const p of (pts || [])) {
        const plena = normalizarGuia(p.nombre_producto || '');
        if (plena && (plena === texto || sinMarca === plena.replace(/aceitedesoya/g, ''))) {
            return { product_key: p.producto_key };
        }
    }
    for (const a of (invs || [])) {
        if (normalizarGuia(a.nombre || '') === texto) {
            return { articulo_id: a.id };
        }
    }
    return null;
}

// Une lo que encontró el lector local con lo que vio la IA. El local manda:
// sus claves salen de los alias del PDF y su cantidad de la columna real de
// la guía. La IA solo aporta los renglones que el local no reconoció (un
// producto cuyo nombre cambió, por ejemplo) y nunca duplica uno ya detectado.
function fusionarItemsSalidas({ itemsTabla = [], itemsIA = [], pts = [], invs = [] }) {
    const advertencias = [];
    const items = [];
    const porClave = new Map();

    const claveDe = (item) => {
        if (item.product_key) return 'PT:' + item.product_key;
        if (item.articulo_id) return 'INS:' + item.articulo_id;
        return 'TXT:' + normalizarGuia(item.nombre || '');
    };

    const empujar = (item) => {
        const clave = claveDe(item);
        const previo = porClave.get(clave);
        if (previo) {
            previo.cantidad += Number(item.cantidad) || 0;
            return previo;
        }
        porClave.set(clave, item);
        items.push(item);
        return item;
    };

    for (const it of itemsTabla) {
        empujar({
            product_key: it.product_key || '',
            articulo_id: it.articulo_id || null,
            nombre: it.nombre || '',
            cantidad: Number(it.cantidad) || 0,
            cantidad_auto: it.cantidad_auto !== false
        });
    }

    for (const it of itemsIA) {
        const nombre = it.nombre || '';
        const nombreCompleto = [nombre, it.presentacion].filter(Boolean).join(' ');
        // La clave que manda la IA solo se acepta si existe en el catálogo:
        // una clave inventada no puede descuadrar el inventario.
        let product_key = esClavePt(it.product_key) ? it.product_key : '';
        let articulo_id = it.articulo_id || null;
        if (!product_key && !articulo_id) {
            const r = resolverItemGuia(nombreCompleto, pts, invs) || resolverItemGuia(nombre, pts, invs);
            if (r && r.product_key) product_key = r.product_key;
            else if (r && r.articulo_id) articulo_id = r.articulo_id;
        }
        const cantidad = Number(it.cantidad ?? it.cantidad_guia) || 0;
        const existente = porClave.get(claveDe({ product_key, articulo_id, nombre: nombreCompleto || nombre }));
        if (existente) {
            if (cantidad > 0 && Number(existente.cantidad) > 0 && Math.abs(cantidad - existente.cantidad) > 0.001) {
                advertencias.push(`"${nombreCompleto || nombre}": el lector del PDF leyó ${existente.cantidad} y la IA ${cantidad}; se conserva la del PDF.`);
            }
            continue;
        }
        empujar({
            product_key,
            articulo_id,
            nombre: nombreCompleto || nombre,
            cantidad,
            cantidad_auto: cantidad > 0
        });
        if (!product_key && !articulo_id) {
            advertencias.push(`Sin producto asociado (revísalo en la lista): "${nombreCompleto || nombre}".`);
        }
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

// Tablas con la etiqueta sola en su línea ("Punto de Partida" / "Punto de
// Llegada") y los valores debajo (formato North Graphic y similares). Si
// ambas etiquetas vienen en la misma línea, los valores vienen mezclados y
// se parten por el ancla de nuestra planta (la llegada es la nuestra).
function direccionesTabla(lineas) {
    const res = { partida: '', llegada: '' };
    const esAlto = l => /^(Dist|Prov|Dep|N[°º]|Fecha|RUC|N[uú]\.?mero|Conductor|Licencia|DNI|Principal|Secundario|Bienes|Indicador|Datos|Veh|Transport|Motivo|Tipo|Observaciones|Orden|Pedido|Condiciones|Factura|Comprob|Marca|Placa|Razon|Direcci[oó]n|Firma|Recib|V°B|DESPACHADO|Representaci)/i.test(l)
        || /^\d{1,2}\s+(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SET|SEP|OCT|NOV|DIC)\b/i.test(l)
        || /^\s*Punto de (Partida|Llegada)\b/i.test(l);
    const esDist = l => /^(Dist|Prov|Dep)\b/i.test(l);
    const ancla = /(AV\.?\s*LOS ANDES|CAJAMARQUILLA|CHOSICA|STA\.?\s*ANITA|SANTA ANITA|LOS CIPRESES)/i;
    for (let i = 0; i < lineas.length; i++) {
        const m = lineas[i].match(/^\s*Punto de (Partida|Llegada)\b(.*)$/i);
        if (!m) continue;
        // Ambas etiquetas en la misma línea: los valores vienen mezclados.
        if (/Punto de (Partida|Llegada)/i.test(m[2])) {
            const partes = [];
            for (let j = i + 1; j < Math.min(i + 7, lineas.length); j++) {
                const s = lineas[j].trim();
                if (!s || esAlto(s)) break;
                partes.push(s);
            }
            const blob = partes.join(' ').replace(/\s+/g, ' ').trim();
            const corte = blob.search(ancla);
            if (corte > 0) {
                if (!res.partida) res.partida = blob.slice(0, corte).replace(/[-–\s,.]+$/, '').trim();
                if (!res.llegada) res.llegada = blob.slice(corte).trim();
            } else if (blob && !res.partida) {
                res.partida = blob;
            }
            continue;
        }
        if (m[2] && m[2].trim()) continue;
        const clave = /^partida/i.test(m[1]) ? 'partida' : 'llegada';
        if (res[clave]) continue;
        const partes = [];
        for (let j = i + 1; j < Math.min(i + 6, lineas.length); j++) {
            const s = lineas[j].trim();
            if (!s) continue;
            if (esDist(s)) continue;
            if (esAlto(s)) break;
            partes.push(s);
        }
        if (partes.length) res[clave] = partes.join(' ').replace(/\s+/g, ' ').trim();
    }
    return res;
}

// Cabecera y transporte de la guía de remisión (emisión SUNAT o formato anterior)
function parsearCabeceraSUNAT(textoPdf) {
    const lineas = textoPdf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const res = { numero_guia: '', ruc: '', empresa: '', destino: '', punto_partida: '', placa: '', chofer: '', dni_chofer: '', licencia: '', orden_compra: '', emisor_ruc: '', es_destinatario_externo: false };

    let m = textoPdf.match(/N[°º.]?\s*([A-Z0-9]{2,8})\s*[-–]\s*(\d{4,8})/i);
    if (m) {
        res.numero_guia = (m[1] + '-' + m[2]).toUpperCase();
    } else {
        // Series como TV01, T001, EG07 o F001, con o sin "N°" delante.
        m = textoPdf.match(/\b([A-Z]{1,4}\s*0?\d{2,3})\s*[-–]\s*(\d{4,8})/i);
        if (m) res.numero_guia = (m[1] + '-' + m[2]).replace(/\s+/g, '').toUpperCase();
        else {
            // Series cortas tipo T009-842: el prefijo trae dígito (T009, F001),
            // a diferencia de placas (AZS-904) u OC (60-2026), que no lo traen
            // al inicio. Solo se usa si no hubo número largo.
            m = textoPdf.match(/\b(?=[A-Z][A-Z0-9-]*\d)([A-Z]{0,3}\d[A-Z0-9]{0,3})\s*[-–]\s*(\d{1,8})/i);
            if (m) res.numero_guia = (m[1] + '-' + m[2]).replace(/\s+/g, '').toUpperCase();
        }
    }

    // RUC del emisor: el primero del documento (cabecera). Acepta "RUC",
    // "RUC N°" y "R.U.C." con o sin dos puntos. Sirve para saber
    // si el destinatario es un cliente real o la propia empresa (traslado
    // interno, donde NO debe autorrellenarse cliente ni RUC).
    const emis = textoPdf.match(/(?:R\.?\s*U\.?\s*C\.?|RUC)\s*:?\s*N?[°º.]?\s*(\d{11})/i);
    if (emis) res.emisor_ruc = emis[1];

    let rucDestinatario = '';
    m = textoPdf.match(/Datos del\s+[Dd]estinatario\s*:?\s*(.+?)\s*-\s*REGISTRO\s*[UÚ]?NICO\s*DE\s*CONTRIBUYENTES\s*N[°º]?\s*(\d{11})/i);
    if (m) {
        res.empresa = m[1].trim();
        res.ruc = m[2];
        rucDestinatario = m[2];
    }
    if (!res.empresa || !res.ruc) {
        // Destinatario en líneas sueltas ("Destinatario : X" + "RUC : Y" en
        // las 2 líneas siguientes), formato de varios proveedores.
        for (let li = 0; li < lineas.length; li++) {
            const md = lineas[li].match(/destinatario\s*:?\s*(.+)$/i);
            if (md && md[1] && !/registro|único|contribuyentes|datos del/i.test(md[1]) && !res.empresa) {
                res.empresa = md[1].replace(/\s*-\s*$/, '').trim();
            }
            const mr = lineas[li].match(/(\d{11})/);
            if (mr && !res.ruc) {
                const ctx = lineas.slice(Math.max(0, li - 2), li + 1).join(' ');
                if (/destinatario/i.test(ctx)) {
                    res.ruc = mr[1];
                    rucDestinatario = mr[1];
                }
            }
            if (res.empresa && res.ruc) break;
        }
    }
    res.es_destinatario_externo = !!(rucDestinatario && res.emisor_ruc && rucDestinatario !== res.emisor_ruc);

    if (!res.ruc) {
        m = textoPdf.match(/(?:R\.?\s*U\.?\s*C\.?|RUC)\s*:?\s*N?[°º.]?\s*(\d{11})/i);
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

    // 1. Tabla con etiquetas solas (North y similares): valores debajo.
    const tab = direccionesTabla(lineas);
    if (tab.partida) res.punto_partida = tab.partida;
    if (tab.llegada) res.destino = tab.llegada;
    // 2. Escáner general solo si trae direcciones limpias (sin cabecera).
    const dirs = extraerDireccionSUNAT(lineas);
    const limpia = s => s && !/R\.?\s*U\.?\s*C\.?|GU[IÍ]A/i.test(s);
    if (!res.punto_partida && limpia(dirs.partida)) res.punto_partida = dirs.partida;
    if (!res.destino && limpia(dirs.llegada)) res.destino = dirs.llegada;
    if (!res.punto_partida) {
        const pp = textoPdf.match(/(?:Punto de\s+|Punto\s+|P\.?\s*)Partida\s*:?\s*(?:\d{6}\s*-\s*)?([A-ZÁÉÍÓÚÑÜ].*)/i);
        if (pp) {
            let dir = pp[1].trim();
            // La dirección puede continuar en las líneas siguientes
            // ("Punto de Partida CAL. LOS CIPRESES... 2DA ETAPA -" y luego
            // "LURIGANCHO - LIMA - LIMA"). Se agregan hasta 2 continuaciones
            // con guion, frenando en la siguiente etiqueta.
            const idx = lineas.findIndex(l => l.includes(pp[1].trim().slice(0, 20)));
            if (idx !== -1) {
                for (let i = idx + 1; i < Math.min(idx + 3, lineas.length); i++) {
                    const s = lineas[i].trim();
                    if (!s || /:/.test(s)) break;
                    if (/Punto de llegada|Datos del|Bienes por transportar/i.test(s)) break;
                    if (!/-/.test(s)) break;
                    dir += ' ' + s;
                }
            }
            res.punto_partida = dir;
        }
    }
    if (!res.destino) {
        const ll = textoPdf.match(/(?:Punto de\s+|Punto\s+|P\.?\s*)Llegada\s*:?\s*(?:\d{6}\s*-\s*)?([A-ZÁÉÍÓÚÑÜ].*)/i);
        if (ll) res.destino = ll[1].trim();
    }
    if (!res.destino) {
        const lleg = textoPdf.match(/(?:Punto de\s+|Punto\s+|P\.?\s*)Llegada\s*:?\s*[\d\s-]+(.*)/i);
        if (lleg) res.destino = lleg[1].trim();
        else {
            const dir = textoPdf.match(/Direcci[oó]n[:\s]*(.*)/i);
            if (dir) res.destino = dir[1].trim();
        }
    }

    let pm = textoPdf.match(/[Nn][°ºoóO0]?\.?\s*(?:úmero de placa del veh[ií]culo|umero de placa del vehiculo)[^\w]*:?\s*([A-Z]{2,3}[-–\s]?\d{3,4})/i);
    if (!pm) pm = textoPdf.match(/Numero de placa[:\s]*([A-Z]{2,3}\s?\d{3,4})/i);
    if (!pm) pm = textoPdf.match(/veh[ií]culo[^\w]*:?\s*([A-Z]{2,3}[-–\s]?\d{3,4})/i);
    if (!pm) pm = textoPdf.match(/Principal[:\s]+([A-Z]{2,3}[-–\s]?\d{3,4})/i);
    if (!pm) pm = textoPdf.match(/\b([A-Z]{2,3}[-–]\d{3,4})\b/i);
    if (!pm) pm = textoPdf.match(/\b([A-Z]\d[A-Z]\d{3})\b/i);
    if (pm) res.placa = pm[1].trim().replace(/\s+/g, '').toUpperCase();

    // Conductor en varias líneas ("Conductor : YAPUCHURI\nJUSCAMAITA,\nCARLOS
    // ALBERTO"): se juntan hasta la siguiente etiqueta.
    let cm = textoPdf.match(/Conductor\b[:\s]*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ .,\n]{1,100}?)(?=\n\s*(?:D[.\s]?N[.\s]?I|DNI|Licencia|Certificado|Tipo|Observaciones|Marca|Placa|RUC|Item\b|C[oó]digo|Bienes|Datos del)\b|\s*$)/i);
    if (cm) cm = [cm[0], cm[1].replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').replace(/[,\s-]+$/, '').trim()];
    if (!cm) cm = textoPdf.match(/Principal[:\s]+([A-ZÁÉÍÓÚÑÜ .]{3,}?)\s*-\s*DOCUMENTO NACIONAL/i);
    if (!cm) cm = textoPdf.match(/Conductor[:\s]*([A-ZÁÉÍÓÚÑÜ .]{3,}?)(?=\s*\r?\n|$|\s*(?:D[.\s]?N[.\s]?I|DNI|Licencia|LIC|Brevete|Placa|Veh[ií]culo|RUC)[:\s])/i);
    if (!cm) cm = textoPdf.match(/Conductor[:\s]*(\d{8})/i);
    if (cm) res.chofer = cm[1].trim().replace(/\s+/g, ' ');

    const dni = textoPdf.match(/DNI[^:\d]{0,25}:?\s*(\d{8})/i)
        || textoPdf.match(/DOCUMENTO NACIONAL DE IDENTIDAD N[°º]?\s*(\d{8})/i)
        || textoPdf.match(/D[.\s]?N[.\s]?I[:\s]*[N°º]?\s*(\d{8})/i);
    if (dni) res.dni_chofer = dni[1];

    const lm = textoPdf.match(/Número de licencia de conducir[:\s]*([A-Z0-9][A-Z0-9-]*[0-9])/i)
        || textoPdf.match(/Número de lincencia de conducir[:\s]*([A-Z0-9][A-Z0-9-]*[0-9])/i)
        || textoPdf.match(/Licencia del conductor[:\s]*([A-Z0-9][A-Z0-9-]*[0-9])/i)
        || textoPdf.match(/Licencia(?:\s+Conducir|\s+del\s+conductor)?[:\s]*([A-Z]?\s*\d{6,9})/i);
    if (lm) res.licencia = lm[1].trim().toUpperCase().replace(/\s+/g, '');

    res.orden_compra = extraerOrdenCompra(textoPdf);

    res.orden_compra = extraerOrdenCompra(textoPdf);

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

// La IA responde con sus nombres (lugar_partida, punto_llegada, producto);
// la app habla partida, destino, nombre (igual que componerCamposDesdeTexto
// y que los dos formularios que rellenan). Se traduce una vez aquí para que
// todo lo que sigue funcione igual venga de IA o del lector local.
//
// El prompt real devuelve los campos EN LA RAÍZ del JSON (no dentro de
// "campos"), así que se leen de ahí y se completan solo los que falten:
// antes la cabecera de la IA entera se tiraba por leerla del sitio equivocado.
const IA_RAIZ_A_CAMPOS = [
    ['numero_guia', 'numero_guia'],
    ['ruc', 'ruc'],
    ['proveedor', 'proveedor'],
    ['empresa', 'empresa'],
    ['chofer', 'chofer'],
    ['dni_chofer', 'dni_chofer'],
    ['placa', 'placa'],
    ['observaciones', 'observaciones'],
    ['partida', 'lugar_partida'],
    ['destino', 'punto_llegada']
];

function normalizarRespuestaIA(ia) {
    if (!ia || typeof ia !== 'object') return ia;
    const c = { ...(ia.campos || {}) };
    for (const [claveCampo, claveRaiz] of IA_RAIZ_A_CAMPOS) {
        if (String(c[claveCampo] ?? '').trim()) continue;
        const valor = ia[claveRaiz];
        if (valor != null && String(valor).trim()) c[claveCampo] = String(valor).trim();
    }
    if (c.partida == null || c.partida === '') c.partida = c.lugar_partida ?? '';
    if (c.destino == null || c.destino === '') c.destino = c.punto_llegada ?? '';
    const items = (Array.isArray(ia.items) ? ia.items : []).map(it => ({
        ...it,
        nombre: it.nombre ?? it.producto ?? '',
        presentacion: it.presentacion ?? '',
        cantidad_guia: it.cantidad_guia ?? it.cantidad ?? 0,
        cantidad: it.cantidad ?? it.cantidad_guia ?? 0
    }));
    return { ...ia, campos: c, items };
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
            licencia: cabecera.licencia,
            orden_compra: extraerOrdenCompra(texto)
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

    // Ítem suelto de una fila de guía de proveedor ("04 15731 ETIQ. BELINI
    // 1 LITRO ... MLL 150.00 100.00", "1 16408 9,775.000 UND Caja de
    // aceite..."). Se quitan los códigos de inicio (n° ítem + código) y la
    // cantidad se busca junto a su unidad (antes o después); si no hay
    // unidad, la última cifra. Devuelve null si no hay nada rescatable.
    const UNID_FILA = 'MLL|MILL|MILLARES|UND|UNI|UNIDADES?|UN|CAJAS?|CJ';
    function extraerItemFila(fila) {
        const f = fila.replace(/^\d{1,3}\s+(?:\d{3,}\s+)?/, '');
        if (!f) return null;
        let m = f.match(new RegExp('(' + UNID_FILA + ')\\s*(\\d[\\d.,]*)', 'i'));
        if (m) {
            const v = parseNumeroGuia(m[2]);
            // Solo se recorta la cola si es una cifra completa (el peso):
            // "…C/U: 1X7" debe quedar intacto.
            if (v !== null) return { nombre: (f.slice(0, m.index) + ' ' + f.slice(m.index + m[0].length)).trim().replace(/\s+/g, ' ').replace(/(?:^|\s)\d[\d.,]*$/, '').trim(), cantidad_guia: v };
        }
        // "9,775.000 UND ...": la cifra pega a la unidad. Pero "12 UND CAJA
        // 600.00" es presentación + total: si después queda otra cifra con
        // decimales, no es cantidad y se sigue buscando al final.
        m = f.match(new RegExp('(\\d[\\d.,]*)\\s*(' + UNID_FILA + ')\\b', 'i'));
        if (m) {
            const despues = f.slice(m.index + m[0].length);
            if (!/\d+[.,]\d+/.test(despues)) {
                const v = parseNumeroGuia(m[1]);
                if (v !== null) return { nombre: (f.slice(0, m.index) + ' ' + despues).trim().replace(/\s+/g, ' '), cantidad_guia: v };
            }
        }
        m = f.match(/^(.{3,120}?)[\s]+([\d][\d.,]{1,10})$/);
        if (m) {
            const v = parseNumeroGuia(m[2]);
            if (v !== null) return { nombre: m[1].trim().replace(/\s+/g, ' '), cantidad_guia: v };
        }
        return null;
    }

    // ítems en bruto de la sección "Bienes por transportar" (insumos, no catálogo de salidas)
    const rechazar = /^(?:BIENES\s+POR\s+TRANSPORTAR|Datos del|N[°º]\.?\s|Fecha|RUC|N[Uu]mero de|P\.?Partida|P\.?Llegada|Conductor|Licencia|D\.?N\.?I|Principal|Secundario|Raz[oó]n|Direcci[oó]n|Unidad de medida|Cantidad|Descripci|C[oó]digo|^Item\b|^TOTAL|^Peso|^T\d{3})/i;
    const filas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const candidatos = [];
    let enBienes = false;
    for (const fila of filas) {
        if (/bienes por transportar/i.test(fila)) { enBienes = true; continue; }
        const it = extraerItemFila(fila);
        if (!it) continue;
        if (enBienes && !rechazar.test(it.nombre) && !/^[A-Z]{2,3}-?\d{3,4}$/i.test(it.nombre)) {
            candidatos.push(it);
        }
    }
    if (candidatos.length === 0) {
        for (const fila of filas) {
            const it = extraerItemFila(fila);
            if (!it) continue;
            if (/^(?:botella|etiqueta|etiq|tapa|balde|ca[ja]s?|preforma|paleta|insumo|aceite|don lalo|belini|corporacion)/i.test(it.nombre) && !rechazar.test(it.nombre)) {
                candidatos.push(it);
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
            const iaCruda = await analizarDocumentoConGemini(dataBuffer, mimetype, textoPdf);
            const ia = normalizarRespuestaIA(iaCruda);
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

        // Solo se autorrellenan cliente y RUC cuando el destinatario es
        // externo (RUC distinto al del emisor). En traslados internos el
        // destinatario es la propia empresa y el cliente se elige a mano
        // (TIENDA / COBERTURA / PROVINCIA).
        if (!cabecera.es_destinatario_externo) {
            cabecera.empresa = '';
            cabecera.ruc = '';
        }

        // El lector local es la base: sus claves salen de los alias del PDF y
        // su cantidad de la columna real de la guía. La IA solo completa los
        // renglones que el local no reconoció (antes lo descartaba por
        // completo, y con él se perdían también sus avisos).
        const { items: itemsTabla, advertencias: advertenciasTabla } = detectarItemsTabla(textoPdf);
        advertencias.push(...advertenciasTabla);
        let itemsDetectados;
        if (itemsIA && itemsIA.length > 0) {
            const pts = await pool.query('SELECT producto_key, nombre_producto FROM producto_terminado');
            const inv = await pool.query('SELECT id, nombre FROM inventario');
            const fusion = fusionarItemsSalidas({ itemsTabla, itemsIA, pts: pts.rows, invs: inv.rows });
            itemsDetectados = fusion.items;
            advertencias.push(...fusion.advertencias);
        } else {
            itemsDetectados = fusionarItemsSalidas({ itemsTabla, itemsIA: [] }).items;
        }

        if (itemsDetectados.length === 0) {
            // Último recurso: buscar cada producto del catálogo en el texto
            // completo con sus propios alias ("B-1 X 1 LT"), no con el nombre
            // literal de la BD ("b-1 1 lt"), que la guía casi nunca escribe
            // igual y dejaba la lista vacía.
            const ptRes = await pool.query('SELECT * FROM producto_terminado');
            for (const pt of ptRes.rows) {
                const alias = PRODUCTOS_PDF_KEYWORDS.find(p => p.product_key === pt.producto_key);
                const formas = [...(alias ? alias.nombres : []), pt.nombre_producto];
                const coincide = formas.map(regexDesdeAlias).find(r => r && r.test(textoPdf));
                if (!coincide) continue;
                const cantidadDetectada = extraerCantidadPdf(textoPdf, [...formas, pt.nombre_producto.toLowerCase()]);
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
            try { ia = normalizarRespuestaIA(await analizarDocumentoConGemini(dataBuffer, mimetype, texto)); }
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
                const ia = normalizarRespuestaIA(await analizarDocumentoConGemini(dataBuffer, mimetype, texto));
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
        const { tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, fecha_salida, usuario, items_json, pedido_id } = req.body;
        const items = JSON.parse(items_json || '[]');
        const despachoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

        if (items.length === 0) {
            return res.status(400).json({ success: false, mensaje: 'Debe incluir al menos un producto en el despacho.' });
        }

        await client.query('BEGIN');
        const estadoGuia = tipo_registro === 'CON GUIA' ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';
        const guiaFinal = numero_guia || 'S/N';
        const guia_url = req.file ? `/uploads/${req.file.filename}` : null;

        // Protocolo de salidas con orden de pedido: si el formulario trae
        // pedido_id, el despacho se valida contra la orden (todo ítem debe ser
        // un producto de la orden y no puede superar lo que falta por despachar)
        // y al cerrar la transacción se descuenta del pedido en pedidos_venta_items.
        let pedido = null;
        const itemsPedido = new Map();
        const pedidoIdNum = parseInt(pedido_id, 10);
        if (pedido_id) {
            if (!Number.isFinite(pedidoIdNum)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: 'Orden de pedido inválida.' });
            }
            const pedRes = await client.query('SELECT * FROM pedidos_venta WHERE id = $1 FOR UPDATE', [pedidoIdNum]);
            if (!pedRes.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, mensaje: 'La orden de pedido ya no existe.' });
            }
            pedido = pedRes.rows[0];
            if (pedido.estado === 'CANCELADO' || pedido.estado === 'DESPACHADO') {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `La orden ${pedido.numero_pedido} está ${pedido.estado}: no admite más salidas.` });
            }
            const itRes = await client.query('SELECT * FROM pedidos_venta_items WHERE pedido_id = $1', [pedidoIdNum]);
            itRes.rows.forEach(i => itemsPedido.set(i.producto_key, i));
            const cantidadesPorKey = new Map();
            for (const item of items) {
                const key = item.producto_key || null;
                const nombre = (item.nombre || key || 'ítem').toString();
                if (!key) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `La salida ligada a la orden solo admite productos del pedido; "${nombre}" es un insumo suelto.` });
                }
                cantidadesPorKey.set(key, (cantidadesPorKey.get(key) || 0) + (parseFloat(item.cantidad) || 0));
            }
            for (const [key, total] of cantidadesPorKey) {
                const linea = itemsPedido.get(key);
                const nombre = linea ? linea.nombre_producto : key;
                if (!linea) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `El producto "${nombre}" no está en la orden ${pedido.numero_pedido}.` });
                }
                const pendiente = Number(linea.cantidad_despacho) - Number(linea.cantidad_despachada);
                if (total > pendiente) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `La orden ${pedido.numero_pedido}: de "${nombre}" solo falta despachar ${pendiente} caja(s) y la salida trae ${total}.` });
                }
            }
        }
        const refDespacho = pedido ? 'Despacho pedido ' + pedido.numero_pedido : 'Despacho N° ' + despachoId;

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
                    referencia: refDespacho + ' - guía ' + guiaFinal
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
                    referencia: refDespacho + ' - guía ' + guiaFinal
                });
            }

            let targetArticuloId = idArticuloFinal;
            if (!targetArticuloId && productoKeyFinal) {
                const matchInv = await client.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [item.nombre]);
                if (matchInv.rows.length > 0) targetArticuloId = matchInv.rows[0].id;
            }

            await client.query(`
                INSERT INTO salidas_almacen 
                (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, articulo_id, cantidad_salida, usuario_registro, estado_guia, guia_url, despacho_id, producto_key, pedido_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17);
            `, [
                fecha_salida || new Date(), tipo_registro, guiaFinal, 
                empresa || 'N/A', ruc || 'N/A', destino || 'N/A', 
                chofer_licencia || 'N/A', placa || 'N/A', punto_partida || 'Almacén Principal', 
                targetArticuloId, cantidad, usuario || 'almacen_user', estadoGuia, guia_url, despachoId, productoKeyFinal,
                pedido ? pedidoIdNum : null
            ]);
        }

        // La salida también descuenta la orden de pedido: se anota en
        // pedidos_venta_items y se reevalúa el estado (EN_PRODUCCION →
        // DESPACHADO cuando ya se mandó todo lo asignado).
        let pedidoEstado = null;
        if (pedido) {
            for (const item of items) {
                const linea = itemsPedido.get(item.producto_key);
                await client.query(
                    'UPDATE pedidos_venta_items SET cantidad_despachada = cantidad_despachada + $1 WHERE id = $2',
                    [parseFloat(item.cantidad), linea.id]
                );
            }
            pedidoEstado = await reevaluarEstadoPedido(client, pedidoIdNum, pedido.estado);
        }

        await client.query('COMMIT');
        const extra = pedido ? ` — orden ${pedido.numero_pedido}: ${pedidoEstado}` : '';
        res.json({
            success: true,
            mensaje: `Despacho de ${items.length} ítem(s) registrado correctamente${extra}.`,
            ...(pedido ? { pedido_estado: pedidoEstado } : {})
        });
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
        // Las salidas que nacieron de un pedido de venta no se borran desde
        // aquí: el pedido es el dueño del flujo y borrar solo la salida dejaría
        // el pedido diciendo DESPACHADO sin su registro de salida.
        if (filas.some(f => f.pedido_id)) {
            return res.status(400).json({ success: false, mensaje: 'Esta salida viene de un pedido de venta: no se puede eliminar desde Salidas. Usa el módulo de Pedidos.' });
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
        // Mismo criterio que eliminar: una salida de pedido se gestiona desde
        // Pedidos, no reescribiendo el historial de salidas.
        if (filas.some(f => f.pedido_id)) {
            return res.status(400).json({ success: false, mensaje: 'Este despacho viene de un pedido de venta: no se puede editar desde Salidas. Usa el módulo de Pedidos.' });
        }

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
        const alm = await pool.query(`SELECT a.*, p.nombre AS proveedor_catalogo
                                         FROM registro_ingresos_almacen a
                                    LEFT JOIN proveedores p ON p.id = a.proveedor_id
                                     ORDER BY a.fecha_registro DESC, a.id DESC`);

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
                ingreso_id: a.id,
                proveedor: a.proveedor || 'N/D',
                proveedor_id: a.proveedor_id !== undefined ? a.proveedor_id : null,
                proveedor_catalogo: a.proveedor_catalogo || null,
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

// Lista mínima del catálogo de la Base de Datos General para separar los
// ingresos por proveedor en Auditoria. No se sirve /api/bd/proveedores aquí:
// ese exige roles de BD General y esta pantalla la abren también producción
// y supervisor.
app.get('/api/auditoria/proveedores', gAuditoria, async (req, res) => {
    try {
        const r = await pool.query('SELECT id, nombre FROM proveedores ORDER BY nombre');
        res.json(r.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Reintenta vincular los ingresos que quedaron sin proveedor del catálogo
// (los proveedores se dan de alta de a poco en BD General): mismo match de la
// migración, corregido en lote y en una sola transaccion.
app.post('/api/auditoria/vincular-proveedores', gAuditoria, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pend = await client.query(
            `SELECT id, proveedor FROM registro_ingresos_almacen
              WHERE proveedor_id IS NULL AND btrim(coalesce(proveedor, '')) <> ''
              ORDER BY id`
        );
        let vinculados = 0;
        if (pend.rows.length) {
            const cat = (await client.query('SELECT id, nombre FROM proveedores ORDER BY id')).rows;
            const filas = [];
            for (const fila of pend.rows) {
                const id = matchProveedorCatalogo(cat, fila.proveedor);
                if (id !== null) filas.push([fila.id, id]);
            }
            if (filas.length) {
                const upd = await client.query(
                    `UPDATE registro_ingresos_almacen r SET proveedor_id = x.proveedor_id
                       FROM unnest($1::int[], $2::int[]) AS x(id, proveedor_id)
                      WHERE r.id = x.id`,
                    [filas.map(f => f[0]), filas.map(f => f[1])]
                );
                vinculados = upd.rowCount;
            }
        }
        await client.query('COMMIT');
        res.json({ success: true, vinculados, revisadas: pend.rows.length });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, mensaje: 'Error al vincular proveedores: ' + err.message });
    } finally {
        client.release();
    }
});

// Vínculo manual de UN ingreso con un proveedor del catálogo: cubre lo que el
// match automático no decide (varias variantes del mismo nombre, texto raro
// o un proveedor que recién se dio de alta con otra redacción). El que
// confirma es quien sabe cual es.
app.post('/api/auditoria/vincular-ingreso', gAuditoria, async (req, res) => {
    try {
        const ingreso_id = Number(req.body.ingreso_id);
        const proveedor_id = Number(req.body.proveedor_id);
        if (!Number.isInteger(ingreso_id) || !ingreso_id || !Number.isInteger(proveedor_id) || !proveedor_id) {
            return res.status(400).json({ success: false, mensaje: 'Indique el ingreso y el proveedor del catálogo.' });
        }
        const prov = await pool.query('SELECT id FROM proveedores WHERE id = $1', [proveedor_id]);
        if (!prov.rows.length) {
            return res.status(404).json({ success: false, mensaje: 'Ese proveedor ya no está en el catálogo.' });
        }
        const upd = await pool.query('UPDATE registro_ingresos_almacen SET proveedor_id = $1 WHERE id = $2', [proveedor_id, ingreso_id]);
        if (!upd.rowCount) {
            return res.status(404).json({ success: false, mensaje: 'El ingreso no existe.' });
        }
        res.json({ success: true, proveedor_id });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: 'Error al vincular el ingreso: ' + err.message });
    }
});

// Ingresos del dia en curso. El corte lo hace la base con CURRENT_DATE, no el
// navegador: asi el servidor manda sobre que dia es y la consulta puede
// aprovechar un indice sobre fecha_ingreso. El rango es [hoy, manana) para
// entrar el dia completo sin depender de la hora.
app.get('/api/vigilancia/ingresos', gVigilancia, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, fecha_ingreso, tipo_documento, numero_guia, proveedor, chofer,
                   dni_chofer, placa, lugar_partida, observaciones, usuario_vigilancia,
                   estado, items_json
            FROM ingresos_vigilancia
            WHERE fecha_ingreso >= CURRENT_DATE
              AND fecha_ingreso <  CURRENT_DATE + INTERVAL '1 day'
            ORDER BY fecha_ingreso DESC
        `);
        res.json(result.rows);
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

// --- AUDITORÍA: BOTELLAS QUE LLEGAN DE LOS SERVICIOS DE SOPLADO ---
// Lo que Almacén registró en Servicios (guías y controles de SAUÑE / B&M),
// una fila por producto con su cantidad en unidades y su categoría. Excluye
// las guías documentales (las que traen controles ya vinculados): esas
// botellas ya contaron al registrar el control y listarlas duplicaría el
// total.
app.get('/api/auditoria/servicios', gAuditoria, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT g.fecha, g.servicio, g.tipo_doc, g.numero,
                   i.producto, i.cantidad, inv.categoria
              FROM servicios_guias_items i
              JOIN servicios_guias g ON g.id = i.guia_id
         LEFT JOIN inventario inv ON inv.id = i.botella_id
             WHERE g.tipo_doc = 'CONTROL'
                OR COALESCE(array_length(g.controles_ids, 1), 0) = 0
             ORDER BY g.fecha DESC NULLS LAST, g.id DESC, i.id
             LIMIT 500
        `);
        res.json(result.rows.map(f => ({
            fecha: f.fecha,
            proveedor: f.servicio,
            numero: f.numero,
            tipo_doc: f.tipo_doc,
            producto: f.producto,
            cantidad: Number(f.cantidad) || 0,
            categoria: f.categoria || 'BOTELLAS Y GALONERAS'
        })));
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

// Núcleo compartido entre reportar directo (/api/produccion/reporte) y cerrar
// una producción abierta (/api/produccion/cerrar): descuenta insumos por
// receta, suma producto terminado e historialea. No abre transacción ni
// escribe la fila del reporte: eso lo hace quien llama. Los errores llevan
// .status (y a veces .detalle) para que la ruta responda bien tras el ROLLBACK.
//
// Si falta stock de un insumo, NO se bloquea: se descuenta lo que hay, el
// producto terminado igual se registra y lo que falto queda PENDIENTE para
// que almacén lo revise y lo salde contra un reporte (soplado) o una guía.
// Si hoy ya se cerró el mismo producto, el cierre se SUMA a esa fila
// (cantidad, toneladas y desglose) en vez de crear otra: en el registro del
// día cada producto sale una sola vez con su total.
async function buscarCierreDelDia(client, productoKey, excluirId) {
    const r = await client.query(
        `SELECT id, cantidad_cajas, toneladas, observaciones, desglose_insumos, lote
           FROM reportes_produccion
          WHERE COALESCE(producto_key, '') = $1
            AND fecha_produccion::date = CURRENT_DATE
            AND COALESCE(estado, '') <> 'EN_CURSO'
            AND id <> $2
          ORDER BY id ASC LIMIT 1 FOR UPDATE`,
        [productoKey, excluirId]
    );
    return r.rows[0] || null;
}

function sumarDesglose(base, nuevo) {
    const mapa = new Map();
    for (const l of (Array.isArray(base) ? base : [])) {
        const k = l.articulo_id != null ? 'i' + l.articulo_id : 'n' + (l.nombre || '');
        mapa.set(k, { ...l, cantidad: Number(l.cantidad) || 0 });
    }
    for (const l of (Array.isArray(nuevo) ? nuevo : [])) {
        const k = l.articulo_id != null ? 'i' + l.articulo_id : 'n' + (l.nombre || '');
        if (mapa.has(k)) mapa.get(k).cantidad = Number(mapa.get(k).cantidad) + (Number(l.cantidad) || 0);
        else mapa.set(k, { ...l, cantidad: Number(l.cantidad) || 0 });
    }
    return [...mapa.values()];
}

function unirObs(base, nueva) {
    const a = String(base || '').trim();
    const b = String(nueva || '').trim();
    if (!b) return a;
    if (!a) return b;
    if (a.includes(b)) return a;
    return a + ' | ' + b;
}

// Dos reportes del mismo dia que se fusionan pueden traer lotes distintos:
// se unen con coma y sin repetir (la clave es minuscula para que "0885" y
// " 0885 " no se aparezcan dos veces).
function unirLotes(base, nuevo) {
    const mapa = new Map();
    for (const parte of [base, nuevo]) {
        for (const trozo of String(parte || '').split(',')) {
            const t = String(trozo).trim();
            if (t && !mapa.has(t.toLowerCase())) mapa.set(t.toLowerCase(), t);
        }
    }
    return [...mapa.values()].join(', ');
}

async function aplicarMovimientosProduccion(client, req, { producto_tipo, presentacion, cajas, usuario, tapaInsumoId = null }) {
    // El motor devuelve hojas de inventario ya aplanadas (insumo_id) con
    // merma y stock de seguridad aplicados: no hay segunda búsqueda por
    // texto que pueda fallar o golpear otro artículo con nombre parecido.
    // `tapaInsumoId` es la tapa que el operario eligio (receta seleccionable,
    // ej. Faisan): sin eleccion se usa la de defecto de la receta.
    const insumosADescontar = await calcularInsumosProduccion(producto_tipo, cajas, client, tapaInsumoId);
    if (!insumosADescontar || insumosADescontar.length === 0) {
        const e = new Error(`No existe receta vigente para "${presentacion}". Contacte a producción para registrar la receta desde el módulo de Recetas.`);
        e.status = 400;
        throw e;
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

    // Se descuenta lo que hay (sin dejar el stock en negativo: hay CHECK) y
    // lo que falte queda pendiente para que almacén lo revise y lo salde
    // contra un reporte de soplado o una guía de ingreso.
    const desglose = [];
    const pendientes = [];
    for (const insumo of obligatorios) {
        const fila = stockPorId.get(insumo.insumo_id);
        const stockActual = fila ? Number(fila.stock || 0) : 0;
        const requerido = Number(insumo.cantidad) || 0;
        const aplicado = fila ? Math.min(stockActual, requerido) : 0;
        if (aplicado > 0) {
            const desc = await client.query(
                'UPDATE inventario SET stock = stock - $1 WHERE id = $2 RETURNING stock',
                [aplicado, insumo.insumo_id]
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
                cantidad: aplicado, tipo_cambio: 'RESTA',
                stock_anterior: stockActual, stock_nuevo: stockNuevo,
                usuario: usuarioResponsable(req, usuario),
                referencia: 'Descuento por envasado: ' + cajas + ' cajas de ' + presentacion
            });
            desglose.push({
                nombre: insumo.nombre,
                articulo_id: insumo.insumo_id,
                cantidad: aplicado,
                unidad_medida: insumo.unidad || (fila ? fila.unidad_medida : 'UNIDADES'),
                categoria: insumo.categoria || (fila ? fila.categoria : '')
            });
        }
        if (requerido - aplicado > 0) {
            pendientes.push({
                articulo_id: fila ? insumo.insumo_id : null,
                articulo_nombre: insumo.nombre,
                cantidad: requerido - aplicado
            });
        }
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

    return { desglose, pendientes };
}

app.post('/api/produccion/reporte', gProduccion, async (req, res) => {
    try {
        const { fecha_produccion, presentacion, cantidad_cajas, toneladas, observaciones, usuario } = req.body;
        const cajas = Number(cantidad_cajas);
        // Tapa elegida por el operario en productos con linea seleccionable.
        const tapa_insumo_id = req.body.tapa_insumo_id ? Number(req.body.tapa_insumo_id) : null;
        // El lote es campo propio obligatorio (antes vivia dentro de obs).
        const loteLimpio = String(req.body.lote ?? '').trim();

        if (!presentacion || !String(presentacion).trim()) {
            return res.status(400).json({ success: false, mensaje: 'Debe seleccionar la presentación de la producción.' });
        }
        if (!loteLimpio) {
            return res.status(400).json({ success: false, mensaje: 'Debe indicar el número de lote.' });
        }
        const producto_tipo = await resolverProductoKey(presentacion);
        if (!producto_tipo) {
            return res.status(400).json({ success: false, mensaje: `La presentación "${presentacion}" no tiene receta registrada.` });
        }
        // stock_cajas es int: un 10.7 pasaba la validación y reventaba con un
        // error de tipo de Postgres en vez de un 400 con mensaje útil.
        if (!Number.isInteger(cajas) || cajas <= 0 || cajas > 1000000) {
            return res.status(400).json({ success: false, mensaje: 'Cantidad de cajas inválida. Debe ser un número entero mayor a 0.' });
        }

        const client = await pool.connect();
        try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user', $1, true)`, [usuarioResponsable(req, usuario) || 'produccion']);
        // La marcha de envasado es solo muestreo en pantalla: no bloquea el
        // registro (igual que el cierre, que nunca la exigió).
        const mov = await aplicarMovimientosProduccion(client, req, { producto_tipo, presentacion, cajas, usuario, tapaInsumoId: tapa_insumo_id });
        // Si quedó una EN_CURSO de este mismo producto (se abrió al elegir
        // "Continuar con este" y aquí se reporta directo), se borra: su estado
        // de "en producción" ya lo cumple este registro.
        await client.query(
            `DELETE FROM reportes_produccion WHERE estado = 'EN_CURSO' AND COALESCE(producto_key, '') = $1`,
            [producto_tipo]
        );
            const tmRep = toneladas === undefined || toneladas === null || toneladas === '' ? 0 : Number(toneladas);
            // Mismo producto dos veces en el día: se suma al registro
            // existente en vez de crear otra fila.
            const destinoRep = await buscarCierreDelDia(client, producto_tipo, -1);
            if (destinoRep) {
                const desgloseF = sumarDesglose(safeParseJson(destinoRep.desglose_insumos), mov.desglose);
                const totalRep = (Number(destinoRep.cantidad_cajas) || 0) + cajas;
                await client.query(
                    `UPDATE reportes_produccion SET cantidad_cajas = $1, toneladas = COALESCE(toneladas,0) + $2, desglose_insumos = $3, observaciones = $4, lote = $5 WHERE id = $6`,
                    [totalRep, tmRep, JSON.stringify(desgloseF), unirObs(destinoRep.observaciones, observaciones), unirLotes(destinoRep.lote, loteLimpio), destinoRep.id]
                );
                for (const p of mov.pendientes) {
                    await client.query(
                        `INSERT INTO ajustes_pendientes (origen, reporte_id, articulo_id, articulo_nombre, cantidad_pendiente, usuario)
                         VALUES ('ENVASADO', $1, $2, $3, $4, $5)`,
                        [destinoRep.id, p.articulo_id, p.articulo_nombre, p.cantidad, usuarioResponsable(req, usuario)]
                    );
                }
                await client.query('COMMIT');
                if (mov.pendientes.length) {
                    const detallePend = mov.pendientes.map(p => `${p.articulo_nombre}: ${p.cantidad} pendiente(s)`).join('; ');
                    return res.json({
                        success: true,
                        mensaje: `Producción registrada y sumada al registro del día ("${presentacion}": total ${totalRep} cajas), con ${mov.pendientes.length} insumo(s) pendiente(s): ${detallePend}.`,
                        advertencia: true,
                        pendientes: mov.pendientes,
                        reporte_id: destinoRep.id
                    });
                }
                return res.json({ success: true, mensaje: `Producción registrada y sumada al registro del día ("${presentacion}": total ${totalRep} cajas).`, reporte_id: destinoRep.id });
            }
            const desgloseJson = JSON.stringify(mov.desglose);

            // producto_key queda guardado en el reporte: al borrarlo, las cajas
            // se devuelven a la clave que realmente se produjo. Antes se
            // re-resolvía por nombre de receta, así que si la receta se desactivó
            // o renombró entre la producción y el borrado, los insumos volvían
            // (van por snapshot) pero las cajas no.
            const repIns = await client.query(
                `INSERT INTO reportes_produccion (fecha_produccion, presentacion, cantidad_cajas, unidad_medida, toneladas, observaciones, usuario_registro, desglose_insumos, producto_key, tapa_insumo_id, lote)
                 VALUES ($1, $2, $3, 'CAJAS', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                [fecha_produccion || hoyPlantaISO(), presentacion, cajas, toneladas, observaciones || '', usuario || 'envasado_user', desgloseJson, producto_tipo, tapa_insumo_id, loteLimpio]
            );
            const reporteId = repIns.rows[0].id;
            for (const p of mov.pendientes) {
                await client.query(
                    `INSERT INTO ajustes_pendientes (origen, reporte_id, articulo_id, articulo_nombre, cantidad_pendiente, usuario)
                     VALUES ('ENVASADO', $1, $2, $3, $4, $5)`,
                    [reporteId, p.articulo_id, p.articulo_nombre, p.cantidad, usuarioResponsable(req, usuario)]
                );
            }

            await client.query('COMMIT');
            if (mov.pendientes.length) {
                const detallePend = mov.pendientes.map(p => `${p.articulo_nombre}: ${p.cantidad} pendiente(s)`).join('; ');
                return res.json({
                    success: true,
                    mensaje: `Producción registrada con ${mov.pendientes.length} insumo(s) pendiente(s) de ajuste: ${detallePend}. Revisa almacén.`,
                    advertencia: true,
                    pendientes: mov.pendientes
                });
            }
            res.json({ success: true, mensaje: 'Reporte registrado y stock de insumos/tapas descontado correctamente.' });
        } catch (innerErr) {
            await client.query('ROLLBACK');
            throw innerErr;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error en reporte producción:", err);
        res.status(err.status || 500).json({
            success: false,
            mensaje: err.message,
            ...(err.detalle ? { errores: err.detalle } : {})
        });
    }
});

// --- ENVASADO: abrir una produccion eligiendo solo el producto. La cantidad
// sale al cerrarla. Solo puede haber una abierta a la vez: asi el cierre
// pregunta "que producto sigue" y la cadena no se rompe.
app.post('/api/produccion/iniciar', gProduccion, async (req, res) => {
    const client = await pool.connect();
    try {
        const { fecha_produccion, presentacion, observaciones, usuario } = req.body;
        const tapa_insumo_id = req.body.tapa_insumo_id ? Number(req.body.tapa_insumo_id) : null;
        if (!presentacion || !String(presentacion).trim()) {
            return res.status(400).json({ success: false, mensaje: 'Debe seleccionar el producto a envasar.' });
        }
        const producto_tipo = await resolverProductoKey(presentacion);
        if (!producto_tipo) {
            return res.status(400).json({ success: false, mensaje: `La presentación "${presentacion}" no tiene receta registrada.` });
        }
        // La tapa elegida se valida contra la receta vigente ANTES de abrir la
        // produccion: un id que no es opcion del producto no puede viajar hasta
        // el cierre, donde ya no hay forma de preguntarle al operario.
        if (tapa_insumo_id) {
            const receta = await obtenerRecetaVigente(producto_tipo, client);
            if (!receta || !eleccionesDesdeTapa(receta, tapa_insumo_id).size) {
                return res.status(400).json({ success: false, mensaje: `La tapa elegida no es una opción válida para "${presentacion}".` });
            }
        }
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user', $1, true)`, [usuarioResponsable(req, usuario) || 'produccion']);
        // La marcha es solo muestreo: iniciar tampoco la exige.
        const abierta = await client.query(
            `SELECT id, presentacion FROM reportes_produccion WHERE estado = 'EN_CURSO' ORDER BY id DESC LIMIT 1`
        );
        if (abierta.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, mensaje: `Ya hay una producción en curso ("${abierta.rows[0].presentacion}"). Ciérrala primero.` });
        }
        const ins = await client.query(
            `INSERT INTO reportes_produccion (fecha_produccion, presentacion, cantidad_cajas, unidad_medida, toneladas, observaciones, usuario_registro, producto_key, estado, tapa_insumo_id)
             VALUES ($1, $2, NULL, 'CAJAS', NULL, $3, $4, $5, 'EN_CURSO', $6) RETURNING id`,
            [fecha_produccion || hoyPlantaISO(), presentacion, observaciones || '', usuario || 'envasado_user', producto_tipo, tapa_insumo_id]
        );
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Producción de "${presentacion}" iniciada.`, reporte_id: ins.rows[0].id });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al iniciar producción:', err);
        res.status(err.status || 500).json({ success: false, mensaje: err.message });
    } finally {
        client.release();
    }
});

// --- ENVASADO: cerrar la produccion en curso con su cantidad producida.
// Recien aqui se descuentan insumos y se suman cajas (mismo nucleo que el
// reporte directo). Despues el operador elige que producto sigue.
app.post('/api/produccion/cerrar', gProduccion, async (req, res) => {
    const client = await pool.connect();
    try {
        const { reporte_id, cantidad_cajas, toneladas, usuario } = req.body;
        // La tapa puede llegar en el cierre (producciones abiertas por la
        // marcha, donde el formulario no estuvo a la vista): si viene, manda
        // sobre la que se guardo al iniciar y se persiste en el reporte.
        const tapaDelCierre = req.body.tapa_insumo_id ? Number(req.body.tapa_insumo_id) : null;
        // El lote se pide al registrar cantidades: puede venir del cuerpo o,
        // si la fila abierta ya lo tenia (se cerro desde el formulario), del
        // reporte mismo.
        const loteLimpio = String(req.body.lote ?? '').trim();
        const cajas = Number(cantidad_cajas);
        const tm = toneladas === undefined || toneladas === null || toneladas === '' ? 0 : Number(toneladas);
        if (!Number.isInteger(cajas) || cajas <= 0 || cajas > 1000000) {
            return res.status(400).json({ success: false, mensaje: 'Cantidad de cajas inválida. Debe ser un número entero mayor a 0.' });
        }
        if (isNaN(tm) || tm < 0) {
            return res.status(400).json({ success: false, mensaje: 'Toneladas inválidas.' });
        }
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user', $1, true)`, [usuarioResponsable(req, usuario) || 'produccion']);
        const repRes = await client.query('SELECT * FROM reportes_produccion WHERE id = $1 FOR UPDATE', [reporte_id]);
        if (!repRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'La producción ya no existe.' });
        }
        const reporte = repRes.rows[0];
        if (reporte.estado !== 'EN_CURSO') {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, mensaje: 'Esa producción ya está cerrada.' });
        }
        const producto_tipo = (reporte.producto_key && String(reporte.producto_key).trim())
            ? String(reporte.producto_key).trim()
            : await resolverProductoKey(reporte.presentacion, client);
        if (!producto_tipo) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `La presentación "${reporte.presentacion}" no tiene receta registrada.` });
        }
        const loteEfectivo = loteLimpio || String(reporte.lote || '').trim();
        if (!loteEfectivo) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Debe indicar el número de lote.' });
        }
        const tapaEfectiva = tapaDelCierre || reporte.tapa_insumo_id || null;
        const mov = await aplicarMovimientosProduccion(client, req, {
            producto_tipo, presentacion: reporte.presentacion, cajas, usuario, tapaInsumoId: tapaEfectiva
        });
        if (tapaDelCierre && tapaDelCierre !== reporte.tapa_insumo_id) {
            await client.query('UPDATE reportes_produccion SET tapa_insumo_id = $1 WHERE id = $2', [tapaDelCierre, reporte_id]);
        }
        // Mismo producto dos veces en el día: se suma al registro existente.
        const destino = await buscarCierreDelDia(client, producto_tipo, reporte_id);
        if (destino) {
            const desgloseF = sumarDesglose(safeParseJson(destino.desglose_insumos), mov.desglose);
            const totalCajas = (Number(destino.cantidad_cajas) || 0) + cajas;
            await client.query(
                `UPDATE reportes_produccion SET cantidad_cajas = $1, toneladas = COALESCE(toneladas,0) + $2, desglose_insumos = $3, observaciones = $4, lote = $5 WHERE id = $6`,
                [totalCajas, tm, JSON.stringify(desgloseF), unirObs(destino.observaciones, reporte.observaciones), unirLotes(destino.lote, loteEfectivo), destino.id]
            );
            for (const p of mov.pendientes) {
                await client.query(
                    `INSERT INTO ajustes_pendientes (origen, reporte_id, articulo_id, articulo_nombre, cantidad_pendiente, usuario)
                     VALUES ('ENVASADO', $1, $2, $3, $4, $5)`,
                    [destino.id, p.articulo_id, p.articulo_nombre, p.cantidad, usuarioResponsable(req, usuario)]
                );
            }
            await client.query(`DELETE FROM reportes_produccion WHERE id = $1`, [reporte_id]);
            await client.query('COMMIT');
            if (mov.pendientes.length) {
                const detallePend = mov.pendientes.map(p => `${p.articulo_nombre}: ${p.cantidad} pendiente(s)`).join('; ');
                return res.json({
                    success: true,
                    mensaje: `Producción de "${reporte.presentacion}" cerrada y sumada al registro del día (total ${totalCajas} cajas), con ${mov.pendientes.length} insumo(s) pendiente(s): ${detallePend}.`,
                    advertencia: true,
                    pendientes: mov.pendientes,
                    reporte_id: destino.id
                });
            }
            return res.json({ success: true, mensaje: `Producción de "${reporte.presentacion}" cerrada y sumada al registro del día (total ${totalCajas} cajas).`, reporte_id: destino.id });
        }
        for (const p of mov.pendientes) {
            await client.query(
                `INSERT INTO ajustes_pendientes (origen, reporte_id, articulo_id, articulo_nombre, cantidad_pendiente, usuario)
                 VALUES ('ENVASADO', $1, $2, $3, $4, $5)`,
                [reporte_id, p.articulo_id, p.articulo_nombre, p.cantidad, usuarioResponsable(req, usuario)]
            );
        }
        await client.query(
            `UPDATE reportes_produccion SET cantidad_cajas = $1, toneladas = $2, estado = 'CERRADO', lote = $3 WHERE id = $4`,
            [cajas, tm, loteEfectivo, reporte_id]
        );
        await client.query('COMMIT');
        if (mov.pendientes.length) {
            const detallePend = mov.pendientes.map(p => `${p.articulo_nombre}: ${p.cantidad} pendiente(s)`).join('; ');
            return res.json({
                success: true,
                mensaje: `Producción de "${reporte.presentacion}" cerrada con ${cajas} cajas, con ${mov.pendientes.length} insumo(s) pendiente(s): ${detallePend}.`,
                advertencia: true,
                pendientes: mov.pendientes,
                reporte_id
            });
        }
        res.json({ success: true, mensaje: `Producción de "${reporte.presentacion}" cerrada con ${cajas} cajas.`, reporte_id });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al cerrar producción:', err);
        res.status(err.status || 500).json({
            success: false,
            mensaje: err.message,
            ...(err.detalle ? { errores: err.detalle } : {})
        });
    } finally {
        client.release();
    }
});

app.get('/api/produccion/reportes', async (req, res) => {
    try {
// Historial completo de producción, sin filtro de fecha a propósito: la
    // fecha la pone quien consulta (ver /api/produccion/informes). El LIMIT es
    // alto para que la lista no se trunque en silencio —con 50, un día con más
    // de 50 reportes perdía el resto sin avisar— y la vista pagina.
    const result = await pool.query('SELECT * FROM reportes_produccion ORDER BY id DESC LIMIT 500');
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
            unidad_medida: r.unidad_medida || 'CAJAS',
            toneladas: r.toneladas,
            estado: r.estado || null,
            usuario_registro: r.usuario_registro,
            observaciones: r.observaciones,
            lote: r.lote || null,
            tapa_insumo_id: r.tapa_insumo_id || null,
            desglose: r.desglose_insumos ? safeParseJson(r.desglose_insumos) : null
        }));

        for (const inf of informes) {
            if (!inf.desglose) {
                const tipo = await resolverProductoKey(inf.presentacion);
                if (tipo) {
                    // Sin desglose guardado se recalcula con la MISMA tapa que
                    // se desconto: el reporte la guarda desde su apertura.
                    const receta = await obtenerRecetaVigente(tipo);
                    const elecciones = inf.tapa_insumo_id ? eleccionesDesdeTapa(receta, inf.tapa_insumo_id) : new Map();
                    const insumos = receta
                        ? await calcularInsumosDeReceta(receta, parseInt(inf.cantidad_cajas, 10) || 0, pool, elecciones)
                        : [];
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

// --- ENVASADO: tapas que el operario puede elegir para un producto. Sale de
// la receta vigente con linea seleccionable (ej. Faisan 900 ml: dorado, rojo
// o verde). El formulario la usa al registrar; el cierre, cuando la produccion
// se abrio por la marcha sin pasar por el formulario.
app.get('/api/produccion/opciones-tapa', async (req, res) => {
    try {
        const producto = String(req.query.producto || '').trim();
        if (!producto) {
            return res.status(400).json({ success: false, mensaje: 'producto requerido' });
        }
        const key = await resolverProductoKey(producto);
        const receta = key ? await obtenerRecetaVigente(key) : null;
        const linea = receta
            ? (receta.insumos || []).find(l => l.seleccionable === true && Array.isArray(l.opciones) && l.opciones.length)
            : null;
        if (!linea) {
            return res.json({ success: true, requiere_tapa: false, opciones: [] });
        }
        res.json({
            success: true,
            requiere_tapa: true,
            producto_key: key,
            receta_insumo_id: linea.id,
            defecto: Number(linea.insumo_id),
            opciones: linea.opciones.map(o => ({
                insumo_id: Number(o.insumo_id),
                nombre: o.nombre,
                unidad: o.unidad_medida || 'UNIDADES',
                stock: o.stock === null || o.stock === undefined ? null : Number(o.stock)
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- PRODUCCIÓN A BASE DE INSUMOS: cuadro global por producto ---
// Para cada producto con receta vigente: el stock de su envase (botellas,
// galoneras, baldes o latas) convertido a cajas, el alcance del stock de
// tapa en cajas (con sugerencias de colores cuando la tapa es elegible) y
// las cajas posibles considerando TODOS los insumos obligatorios.
const CATEGORIA_ENVASE = 'BOTELLAS Y GALONERAS';
const esNombreTapa = (n) => /TAPA|TAPON/i.test(String(n || ''));

app.get('/api/produccion/base-insumos', async (req, res) => {
    try {
        const claves = await pool.query(
            `SELECT DISTINCT producto_key FROM recetas
              WHERE activa = true
                AND vigente_desde <= CURRENT_DATE
                AND (vigente_hasta IS NULL OR vigente_hasta >= CURRENT_DATE)
              ORDER BY producto_key`
        );
        const productos = [];
        for (const { producto_key } of claves.rows) {
            try {
                const receta = await obtenerRecetaVigente(producto_key, pool);
                if (!receta) continue;
                // cajas=1 => cantidades POR CAJA con merma y sub-recetas ya expandidas.
                const insumos = await calcularInsumosDeReceta(receta, 1, pool);

                // Envase: la categoria cubre botellas, galoneras, baldes y latas.
                const envase = insumos
                    .filter(i => String(i.categoria || '').toUpperCase() === CATEGORIA_ENVASE)
                    .sort((a, b) => (Number(b.cantidad_por_caja) || 0) - (Number(a.cantidad_por_caja) || 0))[0];
                // Tapa por NOMBRE: la categoria TAPAS Y ACCESORIOS tambien
                // incluye asas, que no son tapa (mismo criterio que las
                // migraciones de tapa seleccionable).
                const tapa = insumos.find(i =>
                    esNombreTapa(i.nombre) && String(i.categoria || '').toUpperCase().includes('TAPAS')
                );

                const stockEnvase = envase ? Number(envase.stock_actual) || 0 : 0;
                const porCajaEnvase = envase ? Number(envase.cantidad_por_caja) || 0 : 0;
                const cajasPorEnvase = porCajaEnvase > 0 ? Math.floor(stockEnvase / porCajaEnvase) : 0;

                let tapaInfo = null;
                let sugerencias = [];
                if (tapa) {
                    const porCajaTapa = Number(tapa.cantidad_por_caja) || 0;
                    const stockTapa = Number(tapa.stock_actual) || 0;
                    tapaInfo = {
                        nombre: tapa.nombre,
                        por_caja: porCajaTapa,
                        stock: stockTapa,
                        unidad: tapa.unidad,
                        cajas_alcance: porCajaTapa > 0 ? Math.floor(stockTapa / porCajaTapa) : 0
                    };
                    // Tapa elegible (varios colores N°26, etc.): cada opcion
                    // tiene su propio stock; se ofrecen como sugerencias
                    // aparte de la de por defecto de la receta.
                    const lineaSel = (receta.insumos || []).find(l =>
                        l.seleccionable === true && Array.isArray(l.opciones) && l.opciones.length);
                    if (lineaSel) {
                        sugerencias = lineaSel.opciones
                            .filter(o => Number(o.insumo_id) !== Number(lineaSel.insumo_id))
                            .map(o => ({
                                nombre: o.nombre,
                                stock: Number(o.stock) || 0,
                                unidad: o.unidad_medida || 'UNIDADES',
                                cajas_alcance: porCajaTapa > 0 ? Math.floor((Number(o.stock) || 0) / porCajaTapa) : 0
                            }));
                    }
                }

                const cobertura = evaluarCobertura(insumos, 1);
                const obligatorios = cobertura.filter(c => c.obligatorio);
                const cajasMaximas = obligatorios.length
                    ? Math.min(...obligatorios.map(c => c.cajas_posibles))
                    : null;

                productos.push({
                    producto_key,
                    nombre: receta.nombre_producto || producto_key,
                    envase_nombre: envase ? envase.nombre : null,
                    stock_envase: stockEnvase,
                    unidad_envase: envase ? envase.unidad : 'UNIDADES',
                    envase_por_caja: porCajaEnvase,
                    cajas_por_envase: cajasPorEnvase,
                    tapa: tapaInfo,
                    sugerencias,
                    cajas_maximas: cajasMaximas === Infinity ? null : cajasMaximas
                });
            } catch (errProd) {
                console.error(`base-insumos: error con ${producto_key}:`, errProd.message);
            }
        }
        res.json({ success: true, productos });
    } catch (err) {
        console.error('Error en producción a base de insumos:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- AJUSTES PENDIENTES: lo que envasado no pudo descontar por falta de
// stock. Almacén los ve, ajusta para seguir trabajando y cada pendiente se
// salda vinculándolo a un reporte (soplado) o una guía que traiga el insumo.
app.get('/api/almacen/ajustes-pendientes', async (req, res) => {
    try {
        const solo = String(req.query.estado || 'PENDIENTE').toUpperCase();
        const result = await pool.query(
            `SELECT * FROM ajustes_pendientes
              WHERE ($1 = 'TODOS' OR estado = $1)
              ORDER BY fecha_registro DESC, id DESC LIMIT 200`,
            [solo === 'TODOS' ? 'TODOS' : 'PENDIENTE']
        );
        res.json({ success: true, pendientes: result.rows });
    } catch (err) {
        console.error('Error al listar ajustes pendientes:', err);
        res.status(500).json({ success: false, mensaje: 'Error al cargar pendientes: ' + err.message });
    }
});

// Reintento automático: salda todos los pendientes cuyo artículo YA tiene
// stock. Cubre los casos en que el orden no ayudó (el reporte de soplado o la
// guía llegaron antes de que se creara el ajuste, o el ingreso se hizo con una
// versión anterior sin auto-saldado). La pantalla de Ajustes Pendientes lo
// llama al cargarla, así que un pendiente con stock disponible nunca espera a
// que alguien lo vincule a mano.
app.post('/api/almacen/ajustes-pendientes/regularizar', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const pends = await client.query(
            `SELECT DISTINCT articulo_id, articulo_nombre
               FROM ajustes_pendientes
              WHERE estado = 'PENDIENTE'
                AND (articulo_id IS NOT NULL OR COALESCE(BTRIM(articulo_nombre), '') <> '')`
        );
        const usuario = usuarioResponsable(req, req.body && req.body.usuario);
        let regularizados = 0;
        for (const p of pends.rows) {
            regularizados += await regularizarAjustesPendientes(client, {
                articuloId: p.articulo_id ? parseInt(p.articulo_id, 10) : null,
                articuloNombre: p.articulo_nombre,
                usuario,
                vinculoTipo: 'AJUSTE',
                vinculoRef: 'AUTOMÁTICO',
                referencia: 'Ajuste pendiente saldado automáticamente (el stock ya estaba disponible)'
            });
        }
        await client.query('COMMIT');
        res.json({ success: true, regularizados });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al regularizar ajustes pendientes:', err);
        res.status(500).json({ success: false, mensaje: 'Error al regularizar: ' + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/almacen/ajustes-pendientes/:id/aplicar', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        const vinculoTipo = String((req.body && req.body.vinculo_tipo) || '').trim().toUpperCase();
        const vinculoRef = String((req.body && req.body.vinculo_ref) || '').trim();
        if (!id || !vinculoRef) {
            return res.status(400).json({ success: false, mensaje: 'Pendiente y referencia del documento (n° guía o reporte) requeridos.' });
        }
        if (!['SOPLADO', 'GUIA', 'AJUSTE', 'MANUAL'].includes(vinculoTipo)) {
            return res.status(400).json({ success: false, mensaje: 'Tipo de vínculo inválido (SOPLADO, GUIA, AJUSTE o MANUAL).' });
        }
        await client.query('BEGIN');
        const pend = await client.query('SELECT * FROM ajustes_pendientes WHERE id = $1 FOR UPDATE', [id]);
        if (!pend.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El pendiente ya no existe.' });
        }
        const p = pend.rows[0];
        if (p.estado !== 'PENDIENTE') {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, mensaje: 'Ese ajuste ya fue aplicado.' });
        }
        const debe = Number(p.cantidad_pendiente) || 0;
        if (!(debe > 0)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'El pendiente no tiene cantidad por aplicar.' });
        }
        // Se resuelve el artículo: por id, o por nombre si se creó después.
        let articuloId = p.articulo_id ? parseInt(p.articulo_id, 10) : null;
        if (!articuloId) {
            const porNombre = await client.query(
                'SELECT id FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1))',
                [p.articulo_nombre]
            );
            if (porNombre.rows.length) articuloId = porNombre.rows[0].id;
        }
        if (!articuloId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `El artículo "${p.articulo_nombre}" aún no existe en inventario. Créalo primero y vuelve a aplicar.` });
        }
        const st = await client.query('SELECT nombre, stock FROM inventario WHERE id = $1 FOR UPDATE', [articuloId]);
        if (!st.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'El artículo ya no existe en inventario.' });
        }
        const stockActual = Number(st.rows[0].stock) || 0;
        if (stockActual < debe) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `Aún sin stock suficiente de "${st.rows[0].nombre}" (debe ${debe}, hay ${stockActual}). Espera la guía o el reporte y reintenta.` });
        }
        const desc = await client.query(
            'UPDATE inventario SET stock = stock - $1 WHERE id = $2 RETURNING stock',
            [debe, articuloId]
        );
        if (desc.rowCount !== 1) {
            await client.query('ROLLBACK');
            return res.status(500).json({ success: false, mensaje: 'No se pudo descontar el stock.' });
        }
        await actualizarEstadoArticulo(client, st.rows[0].nombre, articuloId);
        await registrarHistorial(client, {
            tipo: 'SALIDA', origen: 'ajuste_pendiente',
            producto: st.rows[0].nombre, articulo_id: articuloId,
            cantidad: debe, tipo_cambio: 'RESTA',
            stock_anterior: stockActual, stock_nuevo: Number(desc.rows[0].stock),
            usuario: usuarioResponsable(req, req.body && req.body.usuario),
            referencia: `Ajuste pendiente saldado con ${vinculoTipo} ${vinculoRef}`
        });
        await client.query(
            `UPDATE ajustes_pendientes
                SET estado = 'APLICADA', cantidad_aplicada = $1,
                    vinculo_tipo = $2, vinculo_ref = $3,
                    aplicado_por = $4, fecha_aplicacion = CURRENT_TIMESTAMP
              WHERE id = $5`,
            [debe, vinculoTipo, vinculoRef,
             usuarioResponsable(req, req.body && req.body.usuario), id]
        );
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Ajuste aplicado: ${debe} de "${st.rows[0].nombre}" vinculado a ${vinculoTipo} ${vinculoRef}.` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al aplicar ajuste pendiente:', err);
        res.status(500).json({ success: false, mensaje: 'Error al aplicar el ajuste: ' + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/produccion/eliminar', gProduccion, async (req, res) => {
    const client = await pool.connect();
    try {
        const { reporte_id } = req.body;
        await client.query('BEGIN');

        // FOR UPDATE: el reporte se bloquea antes de leerlo porque toda la
        // devolucion se calcula a partir de esta fila. Sin el bloqueo, dos
        // borrados simultaneos (doble clic, doble operador, reintento) leen la
        // misma fila, devuelven los insumos dos veces y restan las cajas dos
        // veces: el reporte se borra y el inventario queda inflado.
        const repRes = await client.query('SELECT * FROM reportes_produccion WHERE id = $1 FOR UPDATE', [reporte_id]);
        if (repRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El reporte ya no existe (pudo haber sido cerrado).' });
        }
        const reporte = repRes.rows[0];

        // Un reporte cerrado sin stock dejó pendientes atados por FK: los que
        // siguen PENDIENTE se van con el reporte (nunca movieron stock); si
        // alguno ya fue APLICADO contra guía o reporte, el borrado se bloquea
        // para no corromper lo ya saldado.
        const vinc = await client.query(
            `SELECT id, estado FROM ajustes_pendientes WHERE reporte_id = $1`,
            [reporte_id]
        );
        const aplicadas = vinc.rows.filter(v => v.estado !== 'PENDIENTE');
        if (aplicadas.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, mensaje: `No se puede eliminar: tiene ${aplicadas.length} ajuste(s) ya saldados. Regularízalos en Almacén antes de borrar el reporte.` });
        }

        // Una producción abierta nunca movió stock: se borra directo, sin
        // devoluciones ni avisos de cajas despachadas.
        if (reporte.estado === 'EN_CURSO') {
            await client.query('DELETE FROM reportes_produccion WHERE id = $1', [reporte_id]);
            await client.query('COMMIT');
            return res.json({ success: true, mensaje: 'Producción en curso eliminada (no había movimientos de stock).' });
        }

        // La clave guardada manda. Solo si el reporte es anterior a la migración se
        // re-resuelve por nombre, que es el camino legacy y puede fallar si la
        // receta cambió.
        const producto_tipo = (reporte.producto_key && String(reporte.producto_key).trim())
            ? String(reporte.producto_key).trim()
            : await resolverProductoKey(reporte.presentacion, client);
        const cantidad_cajas = parseInt(reporte.cantidad_cajas, 10);
        // Aviso para el operador cuando las cajas del reporte ya se habian
        // despachado y solo una parte pudo volver al inventario.
        let avisoCajas = null;

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
            // Reportes sin desglose guardado: se recalcula con la tapa que el
            // reporte registro, para devolver exactamente lo que se desconto.
            insumosADevolver = (await calcularInsumosProduccion(producto_tipo, cantidad_cajas, client, reporte.tapa_insumo_id || null))
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
            //
            // Si las cajas del reporte ya se despacharon, no hay stock que
            // restar: la resta completa reventaba contra el CHECK
            // (stock_cajas >= 0) y el ROLLBACK arrastraba la devolución de
            // insumos, dejando un reporte que no se podía borrar de ninguna
            // forma. Se devuelve solo lo que queda y la diferencia se reporta,
            // porque esas cajas se produjeron de verdad: el despache ya las
            // consumió del inventario.
            if (producto_tipo) {
                const stPT = await client.query('SELECT id, nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1 FOR UPDATE', [producto_tipo]);
                if (stPT.rows.length > 0) {
                    const stockAnteriorPT = Number(stPT.rows[0].stock_cajas) || 0;
                    const restituidas = Math.max(0, Math.min(cantidad_cajas, stockAnteriorPT));
                    const noRestituidas = cantidad_cajas - restituidas;
                    if (noRestituidas > 0) {
                        avisoCajas = `De las ${cantidad_cajas} cajas del reporte solo ${restituidas} volvieron al inventario de producto terminado: las ${noRestituidas} restantes ya estaban despachadas. Los insumos se devolvieron completos.`;
                    }
                    if (restituidas > 0) {
                        await client.query(
                            'UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE id = $2',
                            [restituidas, stPT.rows[0].id]
                        );
                    }
                    await registrarHistorial(client, {
                        tipo: 'DEVOLUCION', origen: 'envasado',
                        producto: stPT.rows[0].nombre_producto,
                        producto_key: producto_tipo,
                        cantidad: cantidad_cajas, tipo_cambio: 'RESTA',
                        stock_anterior: stockAnteriorPT, stock_nuevo: stockAnteriorPT - restituidas,
                        usuario: usuarioResponsable(req, req.body.usuario),
                        referencia: 'Devolución al eliminar reporte de ' + reporte.presentacion +
                            (noRestituidas > 0 ? ` (solo ${restituidas} de ${cantidad_cajas}: ${noRestituidas} ya despachadas)` : '')
                    });
                }
            }
        }

        const delPend = await client.query(`DELETE FROM ajustes_pendientes WHERE reporte_id = $1 AND estado = 'PENDIENTE'`, [reporte_id]);
        const pendientesBorrados = delPend.rowCount || 0;
        const del = await client.query('DELETE FROM reportes_produccion WHERE id = $1', [reporte_id]);
        if (del.rowCount !== 1) {
            throw new Error('El reporte cambio mientras se procesaba el borrado. Revisa el inventario y reintenta.');
        }

        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: 'Reporte de producción eliminado. Insumos devueltos al inventario; ya puedes volver a reportarlo.' +
                (pendientesBorrados ? ` Se eliminaron ${pendientesBorrados} pendiente(s) sin saldar.` : ''),
            aviso: avisoCajas
        });
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

        // Archiva TODAS las producciones cerradas (las EN_CURSO no tienen
        // cantidad y no se tocan). No se filtra por fecha: la fecha de la
        // fila puede ser la de ayer si el turno cruzó de día, y el operario
        // no debe adivinarla en un picker. El cierre es una sola acción:
        // "lo cerrado pasa a Auditoría".
        const reportesRes = await client.query(
            `SELECT * FROM reportes_produccion WHERE COALESCE(estado, '') <> 'EN_CURSO'`
        );

        if (reportesRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'No hay producciones cerradas para archivar. Las que siguen en curso no se tocan.' });
        }

        let totalCajas = 0;
        let totalTn = 0;
        const itemsDetalle = reportesRes.rows.map(row => {
            totalCajas += parseFloat(row.cantidad_cajas || 0);
            totalTn += parseFloat(row.toneladas || 0);
            return {
                fecha: row.fecha_produccion ? aFechaSql(row.fecha_produccion) : fecha_cierre,
                presentacion: row.presentacion,
                cant: row.cantidad_cajas,
                um: row.unidad_medida || 'CAJAS',
                tn: row.toneladas,
                lote: row.lote || null,
                obs: row.observaciones
            };
        });

        await client.query(
            `INSERT INTO historial_cierres_produccion (fecha_cierre, total_cajas, total_toneladas, usuario_cierre, detalle_json) 
             VALUES ($1, $2, $3, $4, $5)`,
            [fecha_cierre, totalCajas, totalTn, usuario || 'envasado_user', JSON.stringify(itemsDetalle)]
        );

        // Los pendientes de esos reportes siguen debiéndose: primero se
        // desvinculan (se conservan y se saldan por artículo contra la guía
        // o reporte que traiga el insumo) y recién después se borra.
        const huerf = await client.query(
            `UPDATE ajustes_pendientes SET reporte_id = NULL
              WHERE reporte_id IN (SELECT id FROM reportes_produccion WHERE COALESCE(estado, '') <> 'EN_CURSO')`
        );
        await client.query(`DELETE FROM reportes_produccion WHERE COALESCE(estado, '') <> 'EN_CURSO'`);

        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: 'Cierre de producción realizado con éxito.' +
                ((huerf.rowCount || 0) ? ` Se conservaron ${huerf.rowCount} pendiente(s) sin saldar para seguir saldándolos en Almacén.` : '')
        });
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
// 'admin' entra como en el resto de módulos: ROLES_MODULO y los guards de
// auditoría, BD General e inventario de refinado ya lo admiten. Faltaba aquí y
// era el único 403 real que recibía el administrador (enforce:true).
const ROLES_REFINADO = ['admin', 'auditoria', 'supervisor', 'produccion', 'refinado'];

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

function sanitizarLote(o, usuario) {
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
        // Quién registró el lote. Al editar se conserva el original.
        usuario: String(o.usuario || usuario || '').trim().slice(0, 50),
        insumos: Array.isArray(o.insumos)
            ? o.insumos.map(sanitizarInsumoLote).filter(it => it.nombre && it.cantidad !== null && !isNaN(Number(it.cantidad)) && Number(it.cantidad) > 0)
            : []
    };
}

// Descuenta/restaura un insumo del stock de refinado (Almacén) según el reporte de lotes.
async function aplicarMovimientoStockInsumoRefinado(q, nombre, cantidad, signo, usuario, referencia) {
    if (!nombre || !(Number(cantidad) > 0)) return;
    // FOR UPDATE mantiene la fila bloqueada hasta el COMMIT, asi que el stock que
    // se lee para la auditoria es exactamente el mismo que ve el UPDATE de abajo.
    const res = await q.query('SELECT id, nombre, stock FROM stock_insumos_refinado WHERE LOWER(BTRIM(nombre)) = $1 FOR UPDATE', [String(nombre).trim().toLowerCase()]);
    if (!res.rows.length) return;
    const item = res.rows[0];
    const stockAnterior = Number(item.stock) || 0;
    // El delta viaja al servidor. Calcular el stock absoluto en JavaScript y
    // escribirlo con SET pisaba cualquier movimiento concurrente del mismo
    // insumo: el ultimo en escribir se llevaba un stock ya viejo y el descuento
    // del otro se perdia.
    const upd = await q.query(
        `UPDATE stock_insumos_refinado SET
             stock = GREATEST(0, stock + $1::numeric),
             estado = CASE WHEN GREATEST(0, stock + $1::numeric) <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END,
             usuario_ajuste = $2,
             fecha_ajuste = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING stock`,
        [signo * Number(cantidad), usuario, item.id]
    );
    const stockNuevo = Number(upd.rows[0].stock);
    await registrarHistorial(q, {
        tipo: signo < 0 ? 'SALIDA' : 'ENTRADA',
        origen: 'refinado',
        producto: item.nombre,
        articulo_id: item.id,
        cantidad: Number(cantidad),
        tipo_cambio: signo < 0 ? 'RESTA' : 'SUMA',
        stock_anterior: stockAnterior,
        stock_nuevo: stockNuevo,
        usuario: usuario,
        referencia: referencia || 'Movimiento por lote de refinado'
        // Sin tolerable: si el movimiento no queda en historial, la
        // transacción revierte. Refinado era el único módulo donde el stock se
        // movía sin dejar rastro, y un stock sin registro es indistinguible de
        // un stock inventado.
    });
}

async function aplicarInsumosLoteStock(q, insumos, signo, usuario, referencia) {
    insumos = Array.isArray(insumos) ? insumos : [];
    for (const it of insumos) {
        const cant = (it && it.cantidad !== null && it.cantidad !== undefined) ? Number(it.cantidad) : 0;
        if ((it && it.nombre) && cant > 0) {
            await aplicarMovimientoStockInsumoRefinado(q, it.nombre, cant, signo, usuario, referencia);
        }
    }
}

app.post('/api/refinado/guardar', requerirRolRefinado, async (req, res) => {
    const client = await pool.connect();
    try {
        const { fecha_reporte, turno, lote, observaciones, produccion_manana } = req.body || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha_reporte || ''))) {
            return res.status(400).json({ success: false, mensaje: 'Fecha inválida (use AAAA-MM-DD).' });
        }
        const turnoVal = String(turno || 'DIA').trim().toUpperCase();
        if (!['DIA', 'NOCHE'].includes(turnoVal)) {
            return res.status(400).json({ success: false, mensaje: 'Turno inválido. Use DIA o NOCHE.' });
        }
        await client.query('BEGIN');

        // El reporte del turno se lee, se modifica en memoria y se vuelve a
        // guardar. Sin transaccion, dos personas guardando el mismo turno leen
        // la misma lista de lotes y la ultima escritura pisa la del otro: el
        // lote que se perdio ya habia descontado su stock, que queda sin ningun
        // lote que lo justifique.
        await client.query(
            `INSERT INTO reportes_refinado (fecha_reporte, turno, insumos_json, aceite_json, totales_json, observaciones, usuario_registro)
             VALUES ($1, $2, '[]', '[]', $3, '', $4)
             ON CONFLICT (fecha_reporte, turno) DO NOTHING`,
            [fecha_reporte, turnoVal, JSON.stringify({ produccion_manana: null, total_lotes: 0, total_tm: 0 }), req.usuario]
        );
        const sel = await client.query('SELECT id, aceite_json, totales_json, observaciones FROM reportes_refinado WHERE fecha_reporte = $1 AND turno = $2 FOR UPDATE', [fecha_reporte, turnoVal]);
        let lotes = [];
        let obs = '';
        let totales = null;
        if (sel.rows.length) {
            try { lotes = JSON.parse(sel.rows[0].aceite_json) || []; } catch (e) {}
            try { totales = JSON.parse(sel.rows[0].totales_json) || null; } catch (e) {}
            obs = sel.rows[0].observaciones || '';
        }
        if (lote && typeof lote === 'object') {
            const limpio = sanitizarLote(lote, req.usuario);
            if (!limpio.lote) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: 'Ingrese el número de lote para registrarlo.' });
            }
            const idx = lotes.findIndex(x => String(x.lote || '').trim() === limpio.lote);
            if (idx >= 0) {
                await aplicarInsumosLoteStock(client, lotes[idx].insumos, 1, req.usuario, 'Restauración por edición del lote ' + limpio.lote);
                lotes[idx] = limpio;
            } else {
                lotes.push(limpio);
            }
            await aplicarInsumosLoteStock(client, limpio.insumos, -1, req.usuario, 'Descuento por registro del lote de refinado ' + limpio.lote);
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

        const result = await client.query(`
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

        await client.query('COMMIT');
        res.json({ success: true, mensaje: lote && typeof lote === 'object' ? 'Lote guardado correctamente.' : 'Datos del turno guardados correctamente.', id: result.rows[0].id });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error guardar refinado:", err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/refinado/lotes/eliminar', requerirRolRefinado, async (req, res) => {
    const client = await pool.connect();
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
        await client.query('BEGIN');
        const sel = await client.query('SELECT id, aceite_json, totales_json FROM reportes_refinado WHERE fecha_reporte = $1 AND turno = $2 FOR UPDATE', [fecha_reporte, turnoVal]);
        if (!sel.rows.length) {
            await client.query('ROLLBACK');
            return res.json({ success: true, mensaje: 'No hay reporte para el turno indicado.' });
        }
        let lotes = [];
        let totales = null;
        try { lotes = JSON.parse(sel.rows[0].aceite_json) || []; } catch (e) {}
        try { totales = JSON.parse(sel.rows[0].totales_json) || null; } catch (e) {}
        const antes = lotes.length;
        const loteEliminado = lotes.find(x => String(x.lote || '').trim() === numLote);
        lotes = lotes.filter(x => String(x.lote || '').trim() !== numLote);
        if (lotes.length === antes) {
            await client.query('ROLLBACK');
            return res.json({ success: true, mensaje: 'El lote no existía en este turno.' });
        }
        // El ajuste de stock y el borrado del lote van juntos: si el guardado
        // fallara despues de este descuento, el insumo volveria sin lote que lo
        // consuma.
        if (loteEliminado) {
            await aplicarInsumosLoteStock(client, loteEliminado.insumos, 1, req.usuario, 'Restauración por eliminación del lote de refinado ' + numLote);
        }
        const totalesLimpio = {
            produccion_manana: (totales && totales.produccion_manana) || null,
            total_lotes: lotes.length,
            total_tm: lotes.reduce((sum, a) => sum + (Number(a.cantidad) || 0), 0)
        };
        await client.query(`
            UPDATE reportes_refinado SET
                aceite_json = $1,
                totales_json = $2,
                usuario_registro = $3,
                fecha_registro = CURRENT_TIMESTAMP
            WHERE id = $4`, [
            JSON.stringify(lotes), JSON.stringify(totalesLimpio), req.usuario, sel.rows[0].id
        ]);
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Lote eliminado correctamente.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error eliminar lote refinado:", err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    } finally {
        client.release();
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
    const client = await pool.connect();
    try {
        const { nombre, nuevo_stock } = req.body || {};
        const cantidadNueva = Number(nuevo_stock);
        if (!nombre || isNaN(cantidadNueva)) {
            return res.status(400).json({ success: false, mensaje: 'Indique un insumo válido y que el nuevo stock sea un número.' });
        }
        await client.query('BEGIN');
        // El ajuste y su registro en el historial tienen que ser el mismo hecho:
        // sin transaccion, un historial fallido dejaba el stock cambiado sin
        // rastro de quien lo hizo.
        const actual = await client.query('SELECT id, nombre, stock FROM stock_insumos_refinado WHERE nombre = $1 FOR UPDATE', [String(nombre)]);
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El insumo de refinado no existe.' });
        }
        const stockAnterior = Number(actual.rows[0].stock) || 0;
        await client.query(
            `UPDATE stock_insumos_refinado
             SET stock = $1::numeric,
                 estado = CASE WHEN $1::numeric <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END,
                 usuario_ajuste = $2,
                 fecha_ajuste = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [cantidadNueva, req.usuario, actual.rows[0].id]
        );
        const diferencia = cantidadNueva - stockAnterior;
        await registrarHistorial(client, {
            tipo: 'AJUSTE',
            origen: 'almacen',
            producto: String(nombre),
            articulo_id: actual.rows[0].id,
            cantidad: Math.abs(diferencia),
            tipo_cambio: diferencia >= 0 ? 'SUMA' : 'RESTA',
            stock_anterior: stockAnterior,
            stock_nuevo: cantidadNueva,
            usuario: usuarioResponsable(req, req.body.usuario),
            referencia: 'Ajuste manual de stock de refinado'
            // Sin tolerable: el ajuste y su historial son el mismo hecho. Si la
            // auditoría falla, revierte el ajuste en vez de dejar el stock
            // cambiado sin registro de quién lo hizo.
        });
        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Stock de insumo de refinado ajustado manualmente.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error ajustar stock refinado:', err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    } finally {
        client.release();
    }
});

// Ingreso de insumo de refinado: SUMA la cantidad que llega al stock actual.
// A diferencia del ajuste (que fija el stock a un valor), este botón sirve
// para registrar la llegada de material (aceite crudo, tonsil, sal, tela…)
// sin pisar lo que ya hay en el tanque/inventario.
app.post('/api/almacen/stock-refinado/ingresar', requerirRolAlmacenInvRef, async (req, res) => {
    const client = await pool.connect();
    try {
        const { nombre, cantidad, referencia } = req.body || {};
        const cantidadNueva = Number(cantidad);
        if (!nombre || isNaN(cantidadNueva) || cantidadNueva <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Indique un insumo válido y una cantidad mayor a cero.' });
        }
        await client.query('BEGIN');
        const actual = await client.query('SELECT id, nombre, stock FROM stock_insumos_refinado WHERE nombre = $1 FOR UPDATE', [String(nombre)]);
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El insumo de refinado no existe.' });
        }
        const stockAnterior = Number(actual.rows[0].stock) || 0;
        const stockFinal = stockAnterior + cantidadNueva;
        await client.query(
            `UPDATE stock_insumos_refinado
             SET stock = $1::numeric,
                 estado = CASE WHEN $1::numeric <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END,
                 usuario_ajuste = $2,
                 fecha_ajuste = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [stockFinal, req.usuario, actual.rows[0].id]
        );
        await registrarHistorial(client, {
            tipo: 'INGRESO',
            origen: 'almacen',
            producto: String(nombre),
            articulo_id: actual.rows[0].id,
            cantidad: cantidadNueva,
            tipo_cambio: 'SUMA',
            stock_anterior: stockAnterior,
            stock_nuevo: stockFinal,
            usuario: usuarioResponsable(req, req.body.usuario),
            referencia: String(referencia || '').trim() || 'Ingreso de insumo de refinado'
        });
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Ingreso registrado: +${cantidadNueva}. Stock de "${nombre}" = ${stockFinal}.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error ingreso stock refinado:', err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    } finally {
        client.release();
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

// Hoy en la zona de la planta (Peru, UTC-5), NO en UTC del servidor. En
// Render el proceso corre en UTC: new Date() a las 19:00 ya es manana, y un
// INSERT sin fecha guardaba la produccion al dia siguiente. El cierre del dia
// real no la encontraba y parecia que faltaba cerrar.
const TZ_PLANTA = 'America/Lima';
function hoyPlantaISO() {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ_PLANTA, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const g = t => partes.find(p => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
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

    // La categoria la pone el alta del proveedor y se relee en cada movimiento:
    // el inventario propio de cada proveedor se agrupa por la lista de
    // categorias ya establecida, no por como se escribio el producto en la guia.
    const catRes = await q.query(
        `SELECT categoria FROM proveedores WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1))`,
        [proveedor]
    );
    const categoria = String((catRes.rows[0] && catRes.rows[0].categoria) || '').trim() || null;

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
             SET stock = $1::numeric, unidad = $2, usuario_registro = $3, fecha_actualizacion = CURRENT_TIMESTAMP,
                 categoria = COALESCE($5, categoria)
             WHERE id = $4`,
            [stockNuevo, unidad, usuario, res.rows[0].id, categoria]
        );
    } else {
        stockNuevo = signo < 0 ? 0 : cantidad;
        await q.query(
            `INSERT INTO stock_proveedores (proveedor_nombre, producto, unidad, stock, usuario_registro, categoria)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'General'))`,
            [proveedor, producto, unidad, stockNuevo, usuario, categoria]
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

// Compara nombres de producto o de proveedor como los escribe la gente. Las
// descripciones de los items de la orden y las de la guia salen de dos
// formularios distintos y no coinciden literalmente: acentos, mayusculas y
// espacios repetidos no deberian separar un producto de su orden.
function normalizarTexto(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// Vincula el texto de proveedor de una guia con el catálogo de la Base de
// Datos General. Misma regla que contra las órdenes: gana el nombre exacto
// normalizado; si no, un único candidato que contenga al otro con 5+
// caracteres. Varias opciones o ninguna -> null: el ingreso queda "sin
// vínculo" visible en Auditoria y el texto se conserva tal cual.
function matchProveedorCatalogo(catalogo, nombreProveedor) {
    const texto = normalizarTexto(nombreProveedor);
    if (!texto) return null;
    let exacto = null;
    const contenidos = [];
    for (const p of catalogo) {
        const clave = normalizarTexto(p.nombre);
        if (!clave) continue;
        if (clave === texto) { if (exacto === null) exacto = p.id; continue; }
        if (Math.min(clave.length, texto.length) >= 5 && (clave.includes(texto) || texto.includes(clave))) contenidos.push(p.id);
    }
    if (exacto !== null) return exacto;
    return contenidos.length === 1 ? contenidos[0] : null;
}

async function resolverProveedorId(q, nombreProveedor) {
    if (!normalizarTexto(nombreProveedor)) return null;
    const cat = await q.query('SELECT id, nombre FROM proveedores ORDER BY id');
    return matchProveedorCatalogo(cat.rows, nombreProveedor);
}

// Busca la orden de compra contra la que se va a aplicar una guia y comprueba
// que sea del mismo proveedor: descontarle una guia a la orden de otro proveedor
// descuadra dos inventarios a la vez.
// Devuelve { ok: true, orden } o { ok: false, mensaje }.
async function buscarOrdenParaGuia(q, numero, proveedor) {
    const num = String(numero || '').trim();
    if (!num) return { ok: false, mensaje: 'Indique el número de orden de compra.' };

    // numero es unico por (tipo, numero), asi que el mismo numero puede existir
    // como OC y como OS: gana la OC, que es lo que se declara en la guia.
    const res = await q.query(
        `SELECT o.*, COALESCE(NULLIF(BTRIM(o.proveedor_nombre), ''), p.nombre) AS proveedor_nombre
           FROM ordenes_compras_servicios o
           LEFT JOIN proveedores p ON p.id = o.proveedor_id
          WHERE UPPER(BTRIM(o.numero)) = UPPER(BTRIM($1))
          ORDER BY CASE WHEN UPPER(BTRIM(o.tipo)) = 'OC' THEN 0 ELSE 1 END, o.id DESC`,
        [num]
    );
    if (!res.rows.length) return { ok: false, mensaje: `No existe ninguna orden con el número ${num}.` };

    const orden = res.rows[0];
    if (String(orden.estado) === 'CANCELADA') {
        return { ok: false, mensaje: `La orden ${num} está cancelada y no puede recibir mercadería.` };
    }

    // Se acepta la igualdad exacta o que un nombre contenga al otro: la guia se
    // escribe a mano y a veces trae "Belcen" donde la orden trae la razon social
    // completa. Lo que no se acepta es otro proveedor.
    const declarado = normalizarTexto(proveedor);
    const deLaOrden = normalizarTexto(orden.proveedor_nombre);
    if (declarado && declarado !== deLaOrden) {
        const contenidos = Math.min(declarado.length, deLaOrden.length) >= 5 &&
            (deLaOrden.includes(declarado) || declarado.includes(deLaOrden));
        if (!contenidos) {
            return { ok: false, mensaje: `La orden ${num} pertenece a "${orden.proveedor_nombre}", no a "${proveedor}".` };
        }
    }

    return { ok: true, orden };
}

// Recalcula el estado de la orden a partir de lo recibido en sus items. Es la
// misma regla del boton Recibir: COMPLETADA cuando todos los items llegaron al
// 100%, RECIBIDA cuando llego algo. El stock del proveedor no sirve para esto,
// porque acumula varias ordenes del mismo proveedor y no dice de cual es cada cosa.
// Devuelve el estado vigente.
async function marcarEstadoOrdenRecibido(client, orden) {
    if (String(orden.estado) === 'CANCELADA') return orden.estado;
    const items = (await client.query(
        'SELECT cantidad, recibido FROM ordenes_items WHERE orden_id = $1', [orden.id]
    )).rows;
    if (!items.length) return orden.estado;

    const todosRecibidos = items.every(x => (Number(x.recibido) || 0) >= (Number(x.cantidad) || 0));
    const algunRecibido = items.some(x => (Number(x.recibido) || 0) > 0);
    let estadoNuevo = orden.estado;
    if (String(orden.estado) === 'PENDIENTE' && algunRecibido) estadoNuevo = 'RECIBIDA';
    else if (todosRecibidos) estadoNuevo = 'COMPLETADA';
    else if (algunRecibido) estadoNuevo = 'RECIBIDA';

    if (estadoNuevo !== orden.estado) {
        await client.query('UPDATE ordenes_compras_servicios SET estado = $1 WHERE id = $2', [estadoNuevo, orden.id]);
        orden.estado = estadoNuevo;
    }
    return estadoNuevo;
}

// Abona en la orden lo que trajo la guia de un producto: suma lo recibido del
// item, resta del stock del proveedor contra esa orden y deja la fila del
// registro marcada como ASOCIADA.
// Devuelve { ok: true, aplicada } o { ok: false, mensaje }.
async function asociarItemDeGuia(client, { fila, orden, numeroGuia, usuario }) {
    const cantidad = Number(fila.cantidad) || 0;
    if (!(cantidad > 0)) return { ok: false, mensaje: 'La fila de la guía no tiene una cantidad válida.' };

    const itemsDeOrden = (await client.query('SELECT * FROM ordenes_items WHERE orden_id = $1', [orden.id])).rows;
    const objetivo = itemsDeOrden.find(it =>
        (Number(it.recibido) || 0) < (Number(it.cantidad) || 0) &&
        normalizarTexto(it.descripcion) === normalizarTexto(fila.producto_nombre)
    );
    if (!objetivo) {
        return { ok: false, mensaje: `La orden ${orden.numero} no tiene un ítem pendiente con el producto "${fila.producto_nombre}".` };
    }

    // Si la orden todavia no se emitio, primero suma al stock de proveedores y
    // recien ahi se descuenta lo que llego: hace lo mismo que el boton Recibir.
    if (String(orden.estado) === 'PENDIENTE') {
        await aplicarItemsOrdenStock(client, itemsDeOrden, orden.proveedor_nombre || 'N/D', 1, usuario, orden.numero);
    }

    const pendiente = Math.max(0, (Number(objetivo.cantidad) || 0) - (Number(objetivo.recibido) || 0));
    const aplicada = Math.min(pendiente, cantidad);
    await client.query(
        'UPDATE ordenes_items SET recibido = $1::numeric WHERE id = $2',
        [(Number(objetivo.recibido) || 0) + aplicada, objetivo.id]
    );
    await upsertStockProveedor(client, {
        proveedor: orden.proveedor_nombre || 'N/D',
        producto: objetivo.descripcion,
        unidad: objetivo.unidad || 'UNIDADES',
        cantidad: aplicada, signo: -1,
        usuario, orden_ref: orden.numero,
        origen: 'GUIA', guia_ref: numeroGuia || null
    });
    await client.query(
        `UPDATE registro_ingresos_almacen SET orden_id = $1, orden_item_id = $2, asociacion = 'ASOCIADA' WHERE id = $3`,
        [orden.id, objetivo.id, fila.id]
    );
    await marcarEstadoOrdenRecibido(client, orden);

    return { ok: true, aplicada, pendiente };
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
                (SELECT COUNT(*)::int FROM facturas f4
                 WHERE f4.orden_id = o.id AND f4.estado <> '${FACTURA_NO_IMPUTABLE}') AS n_facturas,
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
            SELECT s.*, COALESCE(NULLIF(BTRIM(s.categoria), ''), p.categoria, 'General') AS categoria_proveedor
            FROM stock_proveedores s
            LEFT JOIN proveedores p ON LOWER(BTRIM(p.nombre)) = LOWER(BTRIM(s.proveedor_nombre))
            WHERE ($1::int IS NULL OR p.id = $1)
            ORDER BY COALESCE(NULLIF(BTRIM(s.categoria), ''), p.categoria, 'General') ASC,
                     LOWER(s.proveedor_nombre) ASC, LOWER(s.producto) ASC`, [proveedorId]);
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

// --- BD GENERAL: PRODUCTOS DE GUÍA SIN ORDEN DE COMPRA (botón Notificaciones) ---
// Todo lo que entra por Almacén o Vigilancia sin OC declarada queda en SIN_OC.
// Aquí es donde se le asigna la orden: mientras no se asocie, no se descuenta
// nada del stock del proveedor.
app.get('/api/bd/guias-sin-oc', requerirRolBDGeneral, async (req, res) => {
    try {
        const filas = await pool.query(`
            SELECT id, fecha_registro, numero_guia, proveedor, producto_nombre, cantidad, unidad_medida, estado
              FROM registro_ingresos_almacen
             WHERE asociacion = 'SIN_OC'
             ORDER BY id DESC
             LIMIT 500`);
        const conteo = await pool.query(
            `SELECT COUNT(*)::int AS total FROM registro_ingresos_almacen WHERE asociacion = 'SIN_OC'`
        );
        res.json({ success: true, pendientes: filas.rows, total: Number(conteo.rows[0].total) || 0 });
    } catch (err) {
        console.error('Error GET guias sin OC:', err);
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Asigna una OC a un producto de guía y abona su cantidad contra esa orden.
app.post('/api/bd/guias-sin-oc/:id/asociar', requerirRolBDGeneral, async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Producto de guía no válido.' });
        }
        await client.query('BEGIN');

        const filaRes = await client.query('SELECT * FROM registro_ingresos_almacen WHERE id = $1', [id]);
        if (!filaRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'El producto de la guía no existe.' });
        }
        const fila = filaRes.rows[0];
        if (String(fila.asociacion) !== 'SIN_OC') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Este producto ya fue asociado o revisado.' });
        }

        const buscada = await buscarOrdenParaGuia(client, (req.body || {}).numero_oc, fila.proveedor);
        if (!buscada.ok) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: buscada.mensaje });
        }

        const r = await asociarItemDeGuia(client, {
            fila, orden: buscada.orden, numeroGuia: fila.numero_guia, usuario: req.usuario
        });
        if (!r.ok) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: r.mensaje });
        }

        // La cabecera de la guía toma la orden de la primera fila que se asocie.
        if (String(fila.numero_guia || '').trim()) {
            await client.query(
                `UPDATE ingresos_vigilancia
                    SET orden_id = $1, orden_numero = $2
                  WHERE orden_id IS NULL
                    AND LOWER(BTRIM(numero_guia)) = LOWER(BTRIM($3))
                    AND LOWER(BTRIM(proveedor)) = LOWER(BTRIM($4))`,
                [buscada.orden.id, buscada.orden.numero, fila.numero_guia, fila.proveedor]
            );
        }

        await client.query('COMMIT');
        const estadoFinal = String(buscada.orden.estado);
        const avisoEstado = estadoFinal === 'COMPLETADA' ? ' La orden quedó COMPLETADA.' : '';
        res.json({
            success: true,
            mensaje: `Producto abonado a la orden ${buscada.orden.numero}.${avisoEstado}`,
            aplicada: r.aplicada,
            estado_orden: estadoFinal
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error asociar guia-orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al asociar la orden: ' + err.message });
    } finally {
        client.release();
    }
});

// Marca un producto de guía como revisado: no tiene orden que vincular y por
// eso no vuelve a aparecer en Notificaciones.
app.post('/api/bd/guias-sin-oc/:id/revisar', requerirRolBDGeneral, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Producto de guía no válido.' });
        }
        const upd = await pool.query(
            `UPDATE registro_ingresos_almacen SET asociacion = 'REVISADA'
              WHERE id = $1 AND asociacion = 'SIN_OC'
              RETURNING id`,
            [id]
        );
        if (!upd.rows.length) {
            return res.status(400).json({ success: false, mensaje: 'El producto no está pendiente de asociar.' });
        }
        res.json({ success: true, mensaje: 'Producto marcado como revisado. No se le descontará ninguna orden.' });
    } catch (err) {
        console.error('Error revisar guia-orden:', err);
        res.status(500).json({ success: false, mensaje: 'Error al marcar el producto: ' + err.message });
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

// ==================== PEDIDOS DE VENTA ====================
// Captura del pedido, evaluación en dos niveles (stock de producto terminado y
// luego insumos de la receta para lo que falta producir), cola de despacho,
// consolidado de requerimientos para planta y PDF de la orden.

const TIPOS_DESTINO = ['TIENDA', 'REPARTO', 'PROVINCIA'];

/** Estado del pedido tras despachar/atender producción: DESPACHADO solo si ya no queda nada. */
async function reevaluarEstadoPedido(client, pedidoId, estadoActual) {
    const t = await client.query(
        `SELECT total_despacho, total_produccion,
                (SELECT COALESCE(SUM(cantidad_despachada), 0) FROM pedidos_venta_items WHERE pedido_id = $1) AS despachada,
                (SELECT COALESCE(SUM(cantidad_producida), 0) FROM pedidos_venta_items WHERE pedido_id = $1) AS producida
           FROM pedidos_venta WHERE id = $1`,
        [pedidoId]
    );
    if (!t.rows.length) return estadoActual;
    const r = t.rows[0];
    const despachoOk = Number(r.despachada) >= Number(r.total_despacho);
    const produccionOk = Number(r.total_produccion) === 0 || Number(r.producida) >= Number(r.total_produccion);
    let nuevo = estadoActual;
    if (despachoOk && produccionOk) nuevo = 'DESPACHADO';
    else if (estadoActual !== 'INSUMOS_FALTANTES' && Number(r.total_produccion) > 0) nuevo = 'EN_PRODUCCION';
    if (nuevo !== estadoActual) {
        await client.query('UPDATE pedidos_venta SET estado = $1 WHERE id = $2', [nuevo, pedidoId]);
    }
    return nuevo;
}

async function armarPedidoDesdeBase(filtroSql, params) {
    const cab = await pool.query(`SELECT * FROM pedidos_venta WHERE ${filtroSql} ORDER BY id DESC`, params);
    const ids = cab.rows.map(r => r.id);
    const items = ids.length
        ? (await pool.query('SELECT * FROM pedidos_venta_items WHERE pedido_id = ANY($1::int[]) ORDER BY id', [ids])).rows
        : [];
    const insumos = ids.length
        ? (await pool.query("SELECT * FROM pedidos_venta_insumos WHERE pedido_id = ANY($1::int[]) AND estado = 'FALTANTE' ORDER BY id", [ids])).rows
        : [];
    const porPedido = new Map();
    cab.rows.forEach(p => porPedido.set(p.id, { ...p, items: [], insumos_faltantes: [] }));
    items.forEach(i => { const p = porPedido.get(i.pedido_id); if (p) p.items.push(i); });
    insumos.forEach(i => { const p = porPedido.get(i.pedido_id); if (p) p.insumos_faltantes.push(i); });
    return Array.from(porPedido.values());
}

app.post('/api/pedidos/crear', gAlmacen, async (req, res) => {
    const client = await pool.connect();
    try {
        const b = req.body || {};
        const tipoDestino = String(b.tipo_destino || '').trim().toUpperCase();
        if (!TIPOS_DESTINO.includes(tipoDestino)) {
            return res.status(400).json({ success: false, mensaje: 'Tipo de destino inválido. Usa TIENDA, REPARTO o PROVINCIA.' });
        }
        const direccion = String(b.direccion || '').trim();
        if ((tipoDestino === 'REPARTO' || tipoDestino === 'PROVINCIA') && !direccion) {
            return res.status(400).json({ success: false, mensaje: 'La dirección de entrega es obligatoria cuando el destino es REPARTO o PROVINCIA.' });
        }
        const bruto = Array.isArray(b.items) ? b.items : [];
        if (!bruto.length) {
            return res.status(400).json({ success: false, mensaje: 'El pedido debe tener al menos un producto.' });
        }
        if (bruto.length > 50) {
            return res.status(400).json({ success: false, mensaje: 'Un pedido no puede tener más de 50 líneas.' });
        }
        const lineas = [];
        for (const raw of bruto) {
            const producto_key = String((raw && raw.producto_key) || '').trim();
            const cantidad = parseInt(raw && raw.cantidad, 10);
            if (!producto_key || !Number.isFinite(cantidad) || cantidad <= 0) {
                return res.status(400).json({ success: false, mensaje: 'Cada producto debe tener clave y una cantidad mayor a cero.' });
            }
            lineas.push({ producto_key, cantidad });
        }

        await client.query('BEGIN');
        const evaluadas = [];
        for (const linea of lineas) {
            const pt = await client.query(
                'SELECT producto_key, nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1',
                [linea.producto_key]
            );
            const receta = await obtenerRecetaVigente(linea.producto_key, client);
            if (!pt.rows.length && !receta) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `El producto "${linea.producto_key}" no existe (ni en producto terminado ni con receta).` });
            }
            const stockPT = pt.rows.length ? Number(pt.rows[0].stock_cajas) || 0 : 0;
            const qsol = linea.cantidad;
            const sPT = Math.min(stockPT, qsol);
            const qprod = qsol - sPT;
            const nombre = pt.rows.length ? pt.rows[0].nombre_producto : (receta.nombre_producto || linea.producto_key);
            let cobertura = [];
            if (qprod > 0) {
                if (!receta) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ success: false, mensaje: `"${nombre}" no tiene receta vigente: no se puede calcular la producción de ${qprod} cajas.` });
                }
                const requeridos = await calcularInsumosProduccion(linea.producto_key, qprod, client);
                cobertura = evaluarCobertura(requeridos, qprod).filter(c => c.obligatorio);
            }
            evaluadas.push({ ...linea, nombre, stockPT, sPT, qprod, cobertura });
        }

        const totalSolicitado = evaluadas.reduce((a, e) => a + e.cantidad, 0);
        const totalDespacho = evaluadas.reduce((a, e) => a + e.sPT, 0);
        const totalProduccion = evaluadas.reduce((a, e) => a + e.qprod, 0);
        const hayFaltantes = evaluadas.some(e => e.cobertura.some(c => !c.alcanza));
        const estado = totalProduccion === 0 ? 'PARA_DESPACHO' : (hayFaltantes ? 'INSUMOS_FALTANTES' : 'EN_PRODUCCION');
        const solicitante = String(b.solicitante || '').trim() || usuarioResponsable(req, null);
        const fechaDespacho = b.fecha_despacho ? String(b.fecha_despacho).trim() : null;
        if (fechaDespacho && !/^\d{4}-\d{2}-\d{2}$/.test(fechaDespacho)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'La fecha de despacho debe tener formato AAAA-MM-DD.' });
        }

        const insert = await client.query(
            `INSERT INTO pedidos_venta (fecha_despacho, solicitante, vehiculo, chofer, tipo_destino, direccion, estado,
                                        total_solicitado, total_despacho, total_produccion, observaciones, usuario_registro)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [fechaDespacho, solicitante, String(b.vehiculo || '').trim() || null, String(b.chofer || '').trim() || null,
             tipoDestino, direccion || null, estado, totalSolicitado, totalDespacho, totalProduccion,
             String(b.observaciones || '').trim() || null, usuarioResponsable(req, b.usuario)]
        );
        const pedidoId = insert.rows[0].id;
        const numero = `PED-${new Date().getFullYear()}-${String(pedidoId).padStart(4, '0')}`;
        await client.query('UPDATE pedidos_venta SET numero_pedido = $1 WHERE id = $2', [numero, pedidoId]);

        for (const e of evaluadas) {
            await client.query(
                `INSERT INTO pedidos_venta_items (pedido_id, producto_key, nombre_producto, cantidad_solicitada, cantidad_despacho, cantidad_produccion)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [pedidoId, e.producto_key, e.nombre, e.cantidad, e.sPT, e.qprod]
            );
            for (const c of e.cobertura) {
                const faltante = Math.max(0, Number(c.solicitado) - Number(c.disponible));
                await client.query(
                    `INSERT INTO pedidos_venta_insumos (pedido_id, producto_key, insumo_id, nombre_insumo, requerido, disponible, faltante, estado)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [pedidoId, e.producto_key, c.insumo_id, c.nombre, c.solicitado, c.disponible, faltante,
                     c.alcanza ? 'OK' : 'FALTANTE']
                );
            }
        }
        await client.query('COMMIT');
        const [pedido] = await armarPedidoDesdeBase('id = $1', [pedidoId]);
        res.json({
            success: true,
            mensaje: `Pedido ${numero} registrado con estado ${estado}.`,
            pedido
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al crear pedido de venta:', err);
        res.status(500).json({ success: false, mensaje: 'No se pudo registrar el pedido.' });
    } finally {
        client.release();
    }
});

app.get('/api/pedidos', async (req, res) => {
    try {
        const pedidos = await armarPedidoDesdeBase('TRUE', []);
        res.json({ success: true, pedidos });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Ojo con el orden de Express: las rutas estáticas (catalogo-pt, stock,
// logistica-opciones, consolidado-produccion) van ANTES de /:id, o el :id se
// las come y responde 400 "Id inválido".
app.get('/api/pedidos/catalogo-pt', async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT producto_key, nombre_producto, stock_cajas FROM producto_terminado ORDER BY nombre_producto'
        );
        res.json({ success: true, productos: r.rows });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Stock para la pestaña "Stock" de pedidos.html: producto terminado en cajas
// e insumos que alguna receta vigente usa (incluidas las opciones seleccionables),
// para ver existencias sin salir del módulo.
app.get('/api/pedidos/stock', async (req, res) => {
    try {
        const pt = await pool.query(
            'SELECT producto_key, nombre_producto, stock_cajas, stock_minimo FROM producto_terminado ORDER BY nombre_producto'
        );
        const insumos = await pool.query(
            `SELECT inv.id, inv.nombre, inv.stock, inv.stock_minimo, inv.unidad_medida, inv.categoria
               FROM inventario inv
              WHERE inv.id IN (
                    SELECT ri.insumo_id FROM receta_insumos ri
                    JOIN recetas r ON r.id = ri.receta_id
                     WHERE r.activa = true AND ri.insumo_id IS NOT NULL
                       AND r.vigente_desde <= CURRENT_DATE
                       AND (r.vigente_hasta IS NULL OR r.vigente_hasta >= CURRENT_DATE)
                    UNION
                    SELECT op.insumo_id FROM receta_insumo_opciones op
                    JOIN receta_insumos ri ON ri.id = op.receta_insumo_id
                    JOIN recetas r ON r.id = ri.receta_id
                     WHERE r.activa = true AND op.insumo_id IS NOT NULL
                       AND r.vigente_desde <= CURRENT_DATE
                       AND (r.vigente_hasta IS NULL OR r.vigente_hasta >= CURRENT_DATE)
              )
              ORDER BY inv.nombre`
        );
        res.json({ success: true, pt: pt.rows, insumos: insumos.rows });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/pedidos/logistica-opciones', async (req, res) => {
    try {
        const placas = await pool.query(
            `SELECT DISTINCT placa FROM (
                SELECT placa FROM salidas_almacen WHERE placa IS NOT NULL AND TRIM(placa) <> ''
                UNION
                SELECT placa FROM ingresos_vigilancia WHERE placa IS NOT NULL AND TRIM(placa) <> ''
             ) t ORDER BY placa`
        );
        const choferes = await pool.query(
            `SELECT DISTINCT chofer FROM (
                SELECT chofer_licencia AS chofer FROM salidas_almacen WHERE chofer_licencia IS NOT NULL AND TRIM(chofer_licencia) <> ''
                UNION
                SELECT chofer FROM ingresos_vigilancia WHERE chofer IS NOT NULL AND TRIM(chofer) <> ''
             ) t ORDER BY chofer`
        );
        res.json({
            success: true,
            placas: placas.rows.map(r => r.placa),
            choferes: choferes.rows.map(r => r.chofer)
        });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.post('/api/pedidos/:id/despachar', gAlmacen, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, mensaje: 'Id inválido.' });
    const client = await pool.connect();
    try {
        // Protocolo de despacho: el pedido manda su guía (opcional). Sin guía
        // la salida queda PENDIENTE REGULARIZAR, igual que una salida manual.
        const b = req.body || {};
        const numeroGuia = String(b.numero_guia || '').trim();
        const tipoRegistro = numeroGuia ? 'CON GUIA' : 'SIN GUIA';
        const estadoGuia = numeroGuia ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';
        const despachoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await client.query('BEGIN');
        const ped = await client.query('SELECT * FROM pedidos_venta WHERE id = $1 FOR UPDATE', [id]);
        if (!ped.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'Pedido no encontrado.' });
        }
        const pedido = ped.rows[0];
        if (pedido.estado === 'CANCELADO' || pedido.estado === 'DESPACHADO') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: `El pedido está ${pedido.estado}: no hay nada por despachar.` });
        }
        const items = (await client.query('SELECT * FROM pedidos_venta_items WHERE pedido_id = $1', [id])).rows;
        const pendientes = items.filter(i => Number(i.cantidad_despacho) - Number(i.cantidad_despachada) > 0);
        if (!pendientes.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'Este pedido ya despachó todo su stock asignado.' });
        }

const despachados = [];
        const completados = [];
        for (const item of pendientes) {
            const restante = Number(item.cantidad_despacho) - Number(item.cantidad_despachada);
            const st = await client.query(
                'SELECT nombre_producto, stock_cajas FROM producto_terminado WHERE producto_key = $1 FOR UPDATE',
                [item.producto_key]
            );
            if (!st.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `El producto "${item.producto_key}" ya no existe en producto terminado.` });
            }
            const stock = Number(st.rows[0].stock_cajas) || 0;
            if (stock < restante) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, mensaje: `Stock insuficiente de "${st.rows[0].nombre_producto}": quedan ${stock} cajas y el pedido necesita ${restante}.` });
            }
            await client.query(
                'UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE producto_key = $2',
                [restante, item.producto_key]
            );
            await client.query(
                'UPDATE pedidos_venta_items SET cantidad_despachada = cantidad_despachada + $1 WHERE id = $2',
                [restante, item.id]
            );
            // Al despachar, las cajas salen de producción: completamos la producción
            // del mismo ítem (no puede despacharse más de lo producido).
            const pendienteProd = Number(item.cantidad_produccion) - Number(item.cantidad_producida);
            const cubrirProd = Math.min(restante, pendienteProd);
            if (cubrirProd > 0) {
                await client.query(
                    'UPDATE pedidos_venta_items SET cantidad_producida = cantidad_producida + $1 WHERE id = $2',
                    [cubrirProd, item.id]
                );
            }
            await registrarHistorial(client, {
                tipo: 'SALIDA',
                origen: 'pedido_venta',
                producto: st.rows[0].nombre_producto,
                producto_key: item.producto_key,
                cantidad: restante,
                tipo_cambio: 'RESTA',
                stock_anterior: stock,
                stock_nuevo: stock - restante,
                usuario: usuarioResponsable(req, b.usuario),
                referencia: `Despacho pedido ${pedido.numero_pedido}`
            });
            await client.query(
                `INSERT INTO salidas_almacen
                   (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino,
                    chofer_licencia, placa, punto_partida, articulo_id, cantidad_salida,
                    usuario_registro, estado_guia, guia_url, despacho_id, producto_key, pedido_id)
                VALUES (CURRENT_TIMESTAMP, $1, $2, $3, 'N/A', $4, $5, $6, 'Almacén Principal', NULL, $7, $8, $9, NULL, $10, $11, $12)`,
                [tipoRegistro, numeroGuia || 'S/N',
                 `${pedido.numero_pedido} — ${pedido.tipo_destino}`,
                 pedido.direccion || pedido.tipo_destino,
                 pedido.chofer || 'N/A', pedido.vehiculo || 'N/A',
                 restante,
                 usuarioResponsable(req, b.usuario),
                 estadoGuia, despachoId, item.producto_key, id]
            );
            despachados.push({
                producto_key: item.producto_key,
                nombre: st.rows[0].nombre_producto,
                cajas: restante
            });
            completados.push({
                numero_pedido: pedido.numero_pedido,
                producto: st.rows[0].nombre_producto,
                producto_key: item.producto_key,
                cantidad: restante,
                guia: numeroGuia || 'S/N',
                chofer: pedido.chofer || 'N/A',
                vehiculo: pedido.vehiculo || 'N/A'
            });
        }

        const nuevoEstado = await reevaluarEstadoPedido(client, id, pedido.estado);
        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: `Despacho del pedido ${pedido.numero_pedido} registrado (${nuevoEstado}). ${completados.length} pedidos completados.`,
            estado: nuevoEstado,
            despachados,
            completados
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al despachar pedido:', err);
        res.status(500).json({ success: false, mensaje: 'No se pudo despachar el pedido.' });
    } finally {
        client.release();
    }
});

app.post('/api/pedidos/:id/cancelar', gAlmacen, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, mensaje: 'Id inválido.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ped = await client.query('SELECT * FROM pedidos_venta WHERE id = $1 FOR UPDATE', [id]);
        if (!ped.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, mensaje: 'Pedido no encontrado.' });
        }
        const pedido = ped.rows[0];
        const despachada = (await client.query(
            'SELECT COALESCE(SUM(cantidad_despachada), 0) AS n FROM pedidos_venta_items WHERE pedido_id = $1', [id]
        )).rows[0].n;
        if (Number(despachada) > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'El pedido ya tiene cajas despachadas: no se puede cancelar.' });
        }
        await client.query("UPDATE pedidos_venta SET estado = 'CANCELADO' WHERE id = $1", [id]);
        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Pedido ${pedido.numero_pedido} cancelado.` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al cancelar pedido:', err);
        res.status(500).json({ success: false, mensaje: 'No se pudo cancelar el pedido.' });
    } finally {
        client.release();
    }
});

// Consolidado de requerimientos: varios pedidos del mismo producto se suman en
// un solo lote para planta, en vez de llegar como tareas aisladas.
app.get('/api/pedidos/consolidado-produccion', async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT i.producto_key,
                    COALESCE(MAX(pt.nombre_producto), MAX(i.nombre_producto)) AS nombre_producto,
                    SUM(i.cantidad_produccion - i.cantidad_producida)::int AS total_pendiente,
                    COUNT(DISTINCT i.pedido_id)::int AS pedidos
               FROM pedidos_venta_items i
               JOIN pedidos_venta p ON p.id = i.pedido_id
               LEFT JOIN producto_terminado pt ON pt.producto_key = i.producto_key
              WHERE p.estado IN ('EN_PRODUCCION', 'INSUMOS_FALTANTES')
                AND i.cantidad_produccion > i.cantidad_producida
              GROUP BY i.producto_key
              ORDER BY total_pendiente DESC`
        );
        res.json({ success: true, consolidado: r.rows });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// Pedidos completados: la pestaña Producción lista sola lo que almacén ya
// despachó (pedido, producto, cantidad, guía y carro salen de la salida
// registrada). Incluye los pedidos despachados a medias, que también deben
// mostrarse en cuanto almacén registró movimiento.
app.get('/api/pedidos/despachados', async (req, res) => {
    try {
        const cab = await pool.query(
            `SELECT p.id, p.numero_pedido, p.estado, p.vehiculo,
                    (SELECT s.numero_guia FROM salidas_almacen s
                      WHERE s.pedido_id = p.id ORDER BY s.id DESC LIMIT 1) AS numero_guia,
                    COALESCE((SELECT s.placa FROM salidas_almacen s
                                WHERE s.pedido_id = p.id AND s.placa IS NOT NULL
                                  AND s.placa <> '' AND s.placa <> 'N/A'
                                ORDER BY s.id DESC LIMIT 1), p.vehiculo) AS carro
               FROM pedidos_venta p
              WHERE p.estado = 'DESPACHADO'
                 OR EXISTS (SELECT 1 FROM pedidos_venta_items i
                             WHERE i.pedido_id = p.id AND i.cantidad_despachada > 0)
              ORDER BY p.id DESC
              LIMIT 50`
        );
        const ids = cab.rows.map(r => r.id);
        const items = ids.length
            ? (await pool.query(
                `SELECT pedido_id, nombre_producto, cantidad_despachada
                   FROM pedidos_venta_items
                  WHERE pedido_id = ANY($1::int[]) AND cantidad_despachada > 0
                  ORDER BY id`, [ids])).rows
            : [];
        const porPedido = new Map();
        cab.rows.forEach(p => porPedido.set(p.id, { ...p, items: [] }));
        items.forEach(i => { const p = porPedido.get(i.pedido_id); if (p) p.items.push(i); });
        res.json({ success: true, pedidos: Array.from(porPedido.values()) });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

app.get('/api/pedidos/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, mensaje: 'Id inválido.' });
    try {
        const pedidos = await armarPedidoDesdeBase('id = $1', [id]);
        if (!pedidos.length) return res.status(404).json({ success: false, mensaje: 'Pedido no encontrado.' });
        res.json({ success: true, pedido: pedidos[0] });
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// La producción ya sumó las cajas al cerrar el reporte; aquí solo se anota en
// el pedido que esas cajas cubren su porción, en orden de llegada.
app.post('/api/pedidos/atender-produccion', gEnvasado, async (req, res) => {
    const producto_key = String((req.body && req.body.producto_key) || '').trim();
    const cajas = parseInt(req.body && req.body.cajas, 10);
    if (!producto_key || !Number.isFinite(cajas) || cajas <= 0) {
        return res.status(400).json({ success: false, mensaje: 'Producto y cantidad de cajas válidos son requeridos.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const filas = (await client.query(
            `SELECT i.id, i.pedido_id, i.cantidad_produccion, i.cantidad_producida, p.numero_pedido, p.estado
               FROM pedidos_venta_items i
               JOIN pedidos_venta p ON p.id = i.pedido_id
              WHERE i.producto_key = $1
                AND p.estado IN ('EN_PRODUCCION', 'INSUMOS_FALTANTES')
                AND i.cantidad_produccion > i.cantidad_producida
              ORDER BY p.id
              FOR UPDATE OF i`,
            [producto_key]
        )).rows;
        let resto = cajas;
        const atendidos = [];
        const pedidosTocados = new Map();
        for (const fila of filas) {
            if (resto <= 0) break;
            const pendiente = Number(fila.cantidad_produccion) - Number(fila.cantidad_producida);
            const cubrir = Math.min(resto, pendiente);
            await client.query(
                'UPDATE pedidos_venta_items SET cantidad_producida = cantidad_producida + $1 WHERE id = $2',
                [cubrir, fila.id]
            );
            resto -= cubrir;
            atendidos.push({ numero_pedido: fila.numero_pedido, cajas: cubrir });
            pedidosTocados.set(fila.pedido_id, fila.estado);
        }
        for (const [pedidoId, estado] of pedidosTocados) {
            await reevaluarEstadoPedido(client, pedidoId, estado);
        }
        await client.query('COMMIT');
        res.json({
            success: true,
            mensaje: resto > 0
                ? `Se atendieron ${cajas - resto} de ${cajas} cajas; ${resto} no tienen pedido pendiente.`
                : `${cajas} cajas atendidas contra pedidos pendientes.`,
            atendidos,
            sin_destino: resto
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error al atender producción de pedidos:', err);
        res.status(500).json({ success: false, mensaje: 'No se pudo registrar la producción atendida.' });
    } finally {
        client.release();
    }
});

app.post('/api/pedidos/:id/pdf', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, mensaje: 'Id inválido.' });
    try {
        const pedidos = await armarPedidoDesdeBase('id = $1', [id]);
        if (!pedidos.length) return res.status(404).json({ success: false, mensaje: 'Pedido no encontrado.' });
        const pedido = pedidos[0];
        const insumosCompletos = (await pool.query(
            'SELECT * FROM pedidos_venta_insumos WHERE pedido_id = $1 ORDER BY id', [id]
        )).rows;
        const fecha = new Date(pedido.fecha_registro);
        const buffer = await generarPDFPedidoVenta({
            ...pedido,
            fecha_registro_larga: fecha.toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'long', timeStyle: 'short' }),
            insumos: insumosCompletos
        });
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${pedido.numero_pedido}.pdf"`
        });
        res.send(buffer);
    } catch (err) {
        console.error('Error al generar PDF de pedido:', err);
        res.status(500).json({ success: false, mensaje: 'No se pudo generar el PDF del pedido.' });
    }
});

// Los errores que llegan acá (multer con archivo muy pesado, un fallo fuera
// de los try de cada ruta) se contestan SIEMPRE en JSON: el lector de salidas
// sube PDFs desde el navegador y una página HTML de error lo hacía mostrar
// "sin conexión con el servidor" en vez del motivo real.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const esLimite = err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE';
    const estado = esLimite ? 413 : 500;
    const mensaje = esLimite
        ? `El archivo supera el máximo de ${Math.round(LIMITE_SUBIDA_BYTES / (1024 * 1024))} MB. Comprime la foto o usa el PDF original.`
        : 'Error del servidor: ' + err.message;
    console.error('Error no manejado en una ruta:', err);
    res.status(estado).json({ success: false, mensaje });
});

// Solo arranca el servidor cuando este archivo es el punto de entrada.
// Si otro módulo lo importa (por ejemplo un test), no se ocupa el puerto.
if (require.main === module) {
    // Rate limiter: usa Redis si hay REDIS_URL; si no, sigue con memoria.
    initRedis().catch(() => {});

    app.listen(PORT, () => {
        console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
    });

    // Apagado ordenado en deploys/restarts de Render: se deja terminar lo que
    // esté en vuelvo y se cierran las conexiones con Supabase. Si algo se
    // queda colgado, a los 8 s el proceso sale igual.
    function apagarSenal(senal) {
        console.log(`${senal}: cerrando conexiones y servidor...`);
        const fuerzaSalida = setTimeout(() => process.exit(0), 8000);
        fuerzaSalida.unref();
        Promise.resolve()
            .then(() => pool.end())
            .catch((err) => console.error('Error al cerrar el pool:', err))
            .finally(() => process.exit(0));
    }
    process.once('SIGTERM', () => apagarSenal('SIGTERM'));
    process.once('SIGINT', () => apagarSenal('SIGINT'));
}

// Los helpers de calculo se exportan para poder probarlos sin levantar el
// servidor: son las reglas que definen los totales de orden y de factura.
module.exports = {
    app, parsearCabeceraSUNAT, detectarItemsTabla, extraerDireccionSUNAT,
    resolverItemGuia, normalizarRespuestaIA, parseNumeroGuia, componerCamposDesdeTexto, fusionarItemsSalidas,
    IGV_POR_DEFECTO, normalizarMoneda, redondear2, normalizarItemsOrden,
    camposEntregaDe, normalizarCuentasBancarias, normalizarNombreInventario, variantesNombreInventario,
    tokensArticulo, resolverArticuloPorNombre
};
