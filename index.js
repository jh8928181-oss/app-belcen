const express = require('express');
const pool = require('./db');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'public/uploads/' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const result = await pool.query('SELECT * FROM usuarios_sistema WHERE usuario = $1 AND password = $2', [usuario, password]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            res.json({ success: true, rol: user.rol, usuario: user.usuario });
        } else {
            res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos' });
        }
    } catch (err) {
        console.error("Error en login:", err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    }
});

// --- VIGILANCIA (SOPORTE MÚLTIPLE DE PRODUCTOS Y DATOS DE TRANSPORTE) ---
app.post('/api/vigilancia/registrar', upload.single('foto_guia'), async (req, res) => {
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
app.get('/api/almacen/pendientes', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM ingresos_vigilancia WHERE estado = 'PENDIENTE CONFORMIDAD' ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener pendientes:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener pendientes: ' + err.message });
    }
});

app.post('/api/almacen/conformidad', async (req, res) => {
    const client = await pool.connect();
    try {
        const { ingreso_id, usuario_almacen } = req.body;
        await client.query('BEGIN');

        const ingresoRes = await client.query('SELECT * FROM ingresos_vigilancia WHERE id = $1', [ingreso_id]);
        const ingreso = ingresoRes.rows[0];
        const items = JSON.parse(ingreso.items_json || '[]');

        let tieneDiferencias = false;

        for (const item of items) {
            let estadoItem = 'CON GUIA';
            if (item.cantidad_guia !== item.cantidad_fisica) {
                tieneDiferencias = true;
                estadoItem = 'POR REGULARIZAR';
            }

            let targetArticuloId = null;
            const existeRes = await client.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [item.nombre]);
            
            if (existeRes.rows.length > 0) {
                targetArticuloId = existeRes.rows[0].id;
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [item.cantidad_fisica, targetArticuloId]);
            } else {
                const nuevoArt = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) VALUES ($1, 'General', $2, 'UNIDADES', 'STOCK SUFICIENTE') RETURNING id`,
                    [item.nombre, item.cantidad_fisica]
                );
                targetArticuloId = nuevoArt.rows[0].id;
            }
            await actualizarEstadoArticulo(client, item.nombre);

            await client.query(`
                INSERT INTO registro_ingresos_almacen (fecha_registro, numero_guia, proveedor, producto_nombre, cantidad, estado, articulo_id)
                VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6);
            `, [ingreso.numero_guia, ingreso.proveedor, item.nombre, item.cantidad_fisica, estadoItem, targetArticuloId]);
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

app.get('/api/almacen/registro-ingresos', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM registro_ingresos_almacen ORDER BY id DESC LIMIT 100`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, mensaje: err.message });
    }
});

// --- ALMACÉN: AJUSTE MANUAL DE INVENTARIO INSUMOS ---
app.post('/api/almacen/ajustar-stock', async (req, res) => {
    try {
        const { articulo_id, nuevo_stock } = req.body;
        
        await pool.query(
            `UPDATE inventario 
             SET stock = $1::numeric, 
                 estado = CASE WHEN $1::numeric <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END 
             WHERE id = $2`,
            [nuevo_stock, articulo_id]
        );

        res.json({ success: true, mensaje: 'Stock de insumo ajustado manualmente.' });
    } catch (err) {
        console.error("Error al ajustar stock:", err);
        res.status(500).json({ success: false, mensaje: 'Error al actualizar el stock manualmente: ' + err.message });
    }
});

// --- PRODUCTO TERMINADO: CONSULTA Y AJUSTE ---
app.get('/api/producto-terminado', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM producto_terminado ORDER BY nombre_producto ASC');
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener productos terminados:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener productos terminados' });
    }
});

app.post('/api/producto-terminado/ajustar', async (req, res) => {
    try {
        const { id, nuevo_stock } = req.body;
        await pool.query('UPDATE producto_terminado SET stock_cajas = $1 WHERE id = $2', [nuevo_stock, id]);
        res.json({ success: true, mensaje: 'Stock de producto terminado actualizado correctamente.' });
    } catch (err) {
        console.error("Error al ajustar producto terminado:", err);
        res.status(500).json({ success: false, mensaje: 'Error al ajustar stock de producto terminado' });
    }
});

// Alta manual de producto terminado SIN descontar insumos (por ejemplo, lotes ya producidos que ingresan a almacén)
app.post('/api/producto-terminado/agregar-manual', async (req, res) => {
    try {
        const { producto_tipo, cantidad } = req.body;
        const cajas = parseInt(cantidad);
        if (!producto_tipo || !cajas || cajas <= 0) {
            return res.status(400).json({ success: false, mensaje: 'Producto y cantidad válida son requeridos.' });
        }
        const nombreLegible = PRODUCTOS_TERMINADOS_MAP[producto_tipo] || producto_tipo;
        await pool.query(`
            INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas)
            VALUES ($1, $2, $3)
            ON CONFLICT (producto_key) 
            DO UPDATE SET stock_cajas = producto_terminado.stock_cajas + EXCLUDED.stock_cajas;
        `, [producto_tipo, nombreLegible, cajas]);
        res.json({ success: true, mensaje: 'Producto terminado agregado manualmente sin descontar insumos.' });
    } catch (err) {
        console.error("Error al agregar producto terminado manual:", err);
        res.status(500).json({ success: false, mensaje: 'Error al agregar producto terminado: ' + err.message });
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
app.post('/api/soplado/registrar', async (req, res) => {
    const client = await pool.connect();
    try {
        const { preforma_nombre, botella_tipo, cantidad_producida, usuario } = req.body;
        await client.query('BEGIN');

        let etiquetaNombre = null;
        let botellaNombre = '';
        let cantidadBotellas = parseInt(cantidad_producida);

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
        await client.query(
            `UPDATE inventario SET stock = stock - $1 WHERE LOWER(nombre) = LOWER($2)`,
            [cantidadBotellas / 1000, preforma_nombre]
        );
        await actualizarEstadoArticulo(client, preforma_nombre);

        // 2. Descontar la etiqueta correspondiente automáticamente (stock en MILL)
        if (etiquetaNombre) {
            await client.query(
                `UPDATE inventario SET stock = stock - $1 WHERE LOWER(nombre) = LOWER($2)`,
                [cantidadBotellas / 1000, etiquetaNombre]
            );
            await actualizarEstadoArticulo(client, etiquetaNombre);
        }

        // 3. Aumentar stock de la botella fabricada en inventario
        await client.query(
            `UPDATE inventario SET stock = stock + $1 WHERE LOWER(nombre) = LOWER($2)`,
            [cantidadBotellas, botellaNombre]
        );
        await actualizarEstadoArticulo(client, botellaNombre);

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

// --- FUNCIÓN AUXILIAR: RECALCULAR ESTADO DE ARTÍCULOS SEGÚN STOCK ---
async function actualizarEstadoArticulo(q, nombre) {
    await q.query(
        `UPDATE inventario SET estado = CASE WHEN stock <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END WHERE LOWER(nombre) = LOWER($1)`,
        [nombre]
    );
}

// --- FUNCIÓN AUXILIAR PARA RECETAS DE ENVASADO ---
function obtenerInsumosReceta(producto_tipo, cantidad, tapa_elegida) {
    const tapaProceso = tapa_elegida || 'Tapa dosif. N° 26 blanco / Dorado';
    let insumos = [];

    switch (producto_tipo) {
        case 'b1_200ml':
            insumos = [
                { nombre: 'Botella de 200 ml - B-1', cantidad: cantidad * 24 },
                { nombre: 'Tapa Tapon 26mm (200ml)', cantidad: (cantidad * 24) / 1000 },
                { nombre: 'Caja B-1 x 200 ml', cantidad: cantidad }
            ];
            break;
        case 'b1_500ml':
            insumos = [
                { nombre: 'Botella de 500 ml - B-1', cantidad: cantidad * 12 },
                { nombre: tapaProceso, cantidad: (cantidad * 12) / 1000 },
                { nombre: 'Caja B-1 x 500 ml', cantidad: cantidad }
            ];
            break;
        case 'b1_900ml':
            insumos = [
                { nombre: 'Botella de 900 ml - B-1', cantidad: cantidad * 12 },
                { nombre: tapaProceso, cantidad: (cantidad * 12) / 1000 },
                { nombre: 'Caja B-1 x 900 ml', cantidad: cantidad }
            ];
            break;
        case 'b1_1lt':
            insumos = [
                { nombre: 'Botella de 1 Lt - B-1', cantidad: cantidad * 12 },
                { nombre: tapaProceso, cantidad: (cantidad * 12) / 1000 },
                { nombre: 'Caja B-1 x 1 lt', cantidad: cantidad }
            ];
            break;
        case 'b1_2lt':
            insumos = [
                { nombre: 'Botella de 2 Lt - B-1', cantidad: cantidad * 6 },
                { nombre: 'Tapa color Rojo 2lt', cantidad: (cantidad * 6) / 1000 },
                { nombre: 'Caja B-1 x 2 lt', cantidad: cantidad }
            ];
            break;
        case 'b1_5lt':
            insumos = [
                { nombre: 'Galonera B-1 x 5 lt', cantidad: cantidad * 4 },
                { nombre: 'Tapa color rojo 5lt', cantidad: (cantidad * 4) / 1000 },
                { nombre: 'Caja B-1 x 5 lt', cantidad: cantidad }
            ];
            break;
        case 'donlalo_800ml':
            insumos = [
                { nombre: 'Botella de 800ml - Don Lalo', cantidad: cantidad * 12 },
                { nombre: tapaProceso, cantidad: (cantidad * 12) / 1000 },
                { nombre: 'Caja Don Lalo x 800ml x 12 und', cantidad: cantidad }
            ];
            break;
        case 'donlalo_20lt':
            insumos = [
                { nombre: 'Balde Don Lalo x 20lt', cantidad: cantidad * 1 },
                { nombre: 'TAAAAPA BALDE DON LALO', cantidad: cantidad * 1 }
            ];
            break;
        case 'belini_200ml':
            insumos = [
                { nombre: 'Botella Belini x 200 ml', cantidad: cantidad * 24 },
                { nombre: 'Tapa Tapon 26mm (200ml)', cantidad: (cantidad * 24) / 1000 },
                { nombre: 'Caja Belini x 200 ml', cantidad: cantidad }
            ];
            break;
        case 'belini_500ml':
            insumos = [
                { nombre: 'Botella Belini x 500 ml', cantidad: cantidad * 12 },
                { nombre: tapaProceso, cantidad: (cantidad * 12) / 1000 },
                { nombre: 'Caja Belini x 500 ml', cantidad: cantidad }
            ];
            break;
        case 'belini_900ml':
            insumos = [
                { nombre: 'Botella Belini x 900 ml', cantidad: cantidad * 12 },
                { nombre: tapaProceso, cantidad: (cantidad * 12) / 1000 },
                { nombre: 'Caja Belini x 900 ml', cantidad: cantidad }
            ];
            break;
        case 'belini_1lt':
            insumos = [
                { nombre: 'Botella Belini x 1 Lt', cantidad: cantidad * 12 },
                { nombre: tapaProceso, cantidad: (cantidad * 12) / 1000 },
                { nombre: 'CAJA BELINI X 1 LITRO', cantidad: cantidad }
            ];
            break;
        case 'belini_2lt':
            insumos = [
                { nombre: 'Galonera Belini x 2 lt', cantidad: cantidad * 6 },
                { nombre: 'Tapa color Rojo 2lt', cantidad: (cantidad * 6) / 1000 },
                { nombre: 'Caja Belini x 2 lt', cantidad: cantidad }
            ];
            break;
        case 'belini_3lt':
            insumos = [
                { nombre: 'Botella Belini x 3 lt', cantidad: cantidad * 4 },
                { nombre: tapaProceso, cantidad: (cantidad * 4) / 1000 },
                { nombre: 'Asas plasticas color celeste pico 45', cantidad: (cantidad * 4) / 1000 },
                { nombre: 'Caja BELINI X 3 LITROS', cantidad: cantidad }
            ];
            break;
        case 'belini_5lt':
            insumos = [
                { nombre: 'Galonera Belini x 5 lt', cantidad: cantidad * 4 },
                { nombre: 'Tapa color rojo 5lt', cantidad: (cantidad * 4) / 1000 },
                { nombre: 'Caja Belini x 5 lt', cantidad: cantidad }
            ];
            break;
        case 'belini_lata18lt':
            insumos = [
                { nombre: 'Lata Belini 18lt', cantidad: cantidad * 1 }
            ];
            break;
        case 'belini_balde18lt':
            insumos = [
                { nombre: 'Balde Belini x 18 lt', cantidad: cantidad * 1 },
                { nombre: 'Tapa BALDE BELINI color amarillo', cantidad: cantidad * 1 }
            ];
            break;
        default:
            throw new Error('Tipo de producto desconocido para la receta de envasado.');
    }
    return insumos;
}

// --- ENVASADO ---
app.post('/api/envasado/registrar', async (req, res) => {
    const client = await pool.connect();
    try {
        const { producto_tipo, cantidad_producida, numero_lote, tapa_elegida } = req.body; 
        await client.query('BEGIN');

        const insumosADescontar = obtenerInsumosReceta(producto_tipo, cantidad_producida, tapa_elegida);

        const faltantes = [];
        for (const insumo of insumosADescontar) {
            const stockRes = await client.query('SELECT stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [insumo.nombre]);
            const stockActual = stockRes.rows.length > 0 ? Number(stockRes.rows[0].stock || 0) : 0;
            if (stockActual < insumo.cantidad) {
                faltantes.push(`${insumo.nombre}: requiere ${insumo.cantidad} | stock: ${stockActual}`);
            }
        }
        if (faltantes.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                mensaje: 'Stock insuficiente. No se registró nada:\n- ' + faltantes.join('\n- ')
            });
        }

        for (const insumo of insumosADescontar) {
            await client.query(
                `UPDATE inventario SET stock = stock - $1 WHERE LOWER(nombre) = LOWER($2)`,
                [insumo.cantidad, insumo.nombre]
            );
            await actualizarEstadoArticulo(client, insumo.nombre);
        }

        const nombreLegible = PRODUCTOS_TERMINADOS_MAP[producto_tipo] || producto_tipo;
        await client.query(`
            INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas)
            VALUES ($1, $2, $3)
            ON CONFLICT (producto_key) 
            DO UPDATE SET stock_cajas = producto_terminado.stock_cajas + EXCLUDED.stock_cajas;
        `, [producto_tipo, nombreLegible, cantidad_producida]);

        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Producción del lote ${numero_lote || 'S/N'} registrada (+${cantidad_producida} cajas a Producto Terminado).` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en registro de envasado:', error);
        res.status(500).json({ success: false, mensaje: 'Error al procesar la producción: ' + error.message });
    } finally {
        client.release();
    }
});

// --- FUNCIÓN AUXILIAR: EXTRAER CANTIDAD DE UN PDF CERCANA A UNA CLAVE DE PRODUCTO ---
function extraerCantidadPdf(textoPdf, claves) {
    for (const clave of claves) {
        const idx = textoPdf.indexOf(clave);
        if (idx === -1) continue;
        const ventana = textoPdf.slice(Math.max(0, idx - 300), idx + 300);
        let m = ventana.match(/(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:UNID|UNI|UND|U\.|UA|CAJAS?|CJ|PAQUETES?|PACKS?|BULTOS?)\b/i);
        if (m) { const v = parseFloat(m[1].replace(',', '.')); if (v > 0 && v < 100000) return v; }
        m = ventana.match(/(?:CANT|CANTIDAD|TOTAL|P\.?CANT)[\s.:]*(\d{1,6}(?:[.,]\d{1,3})?)/i);
        if (m) { const v = parseFloat(m[1].replace(',', '.')); if (v > 0 && v < 100000) return v; }
        m = ventana.match(/\(\s*(\d{1,6}(?:[.,]\d{1,3})?)\s*\)/);
        if (m) { const v = parseFloat(m[1].replace(',', '.')); if (v > 0 && v < 100000) return v; }
    }
    return null;
}

// --- LECTOR INTELIGENTE DE PDF PARA SALIDAS ---
app.post('/api/salidas/leer-pdf', upload.single('archivo_guia'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, mensaje: 'No se subió ningún archivo PDF.' });
        }

        const dataBuffer = fs.readFileSync(req.file.path);
        const pdfData = await pdfParse(dataBuffer);
        const textoPdf = pdfData.text;

        let numero_guia = '';
        let ruc = '';
        let empresa = '';
        let destino = '';
        let chofer_licencia = '';
        let placa = '';

        const guiaMatch = textoPdf.match(/([T|F|B]\s*0\d{2}\s*[-]\s*\d{1,8})/i);
        if (guiaMatch) {
            numero_guia = guiaMatch[1].replace(/\s+/g, '');
        }

        const rucMatches = textoPdf.match(/RUC[:\s]*(\d{11})/gi);
        if (rucMatches && rucMatches.length > 0) {
            const numRuc = rucMatches[rucMatches.length - 1].match(/(\d{11})/);
            if (numRuc) ruc = numRuc[1];
        }

        const razonSocialMatch = textoPdf.match(/Razón Social[:\s]*(.*)/i);
        if (razonSocialMatch) {
            empresa = razonSocialMatch[1].trim();
        } else {
            empresa = 'CORPORACION DON LALO S.A.C.';
        }

        const llegadaMatch = textoPdf.match(/P\.Llegada[:\s]*[\d\s-]+(.*)/i);
        if (llegadaMatch) {
            destino = llegadaMatch[1].trim();
        } else {
            const dirMatch = textoPdf.match(/Dirección[:\s]*(.*)/i);
            if (dirMatch) destino = dirMatch[1].trim();
        }

        const placaMatch = textoPdf.match(/(?:placa|veh[ií]culo)[^\w]*([A-Z0-9-]+)/i);
        if (placaMatch) {
            placa = placaMatch[1].trim();
        }

        const licenciaMatch = textoPdf.match(/(?:licencia|conductor)[^\w]*([A-Z0-9]+)/i);
        if (licenciaMatch) {
            chofer_licencia = licenciaMatch[1].trim();
        }

        let itemsDetectados = [];
        const advertencias = [];

        const productosGuia = [
            { product_key: 'b1_1lt', nombre: 'Aceite de Soya B-1 1 Lt', claves: ['1030004', 'ACEITE DE SOYA B-1 X 1 L'], cantidadBase: 254 },
            { product_key: 'donlalo_800ml', nombre: 'Aceite de Soya Don Lalo 800 ml', claves: ['1040003', 'DON LALO X 800ML'], cantidadBase: 400 },
            { product_key: 'belini_2lt', nombre: 'Aceite de Soya Belini 2 Lt (Galonera)', claves: ['1050005', 'BELINI X 2 L'], cantidadBase: 100 }
        ];

        for (const prod of productosGuia) {
            if (prod.claves.some(c => textoPdf.includes(c))) {
                const cantidadDetectada = extraerCantidadPdf(textoPdf, prod.claves);
                const cantidad = cantidadDetectada || prod.cantidadBase;
                itemsDetectados.push({
                    product_key: prod.product_key,
                    nombre: prod.nombre,
                    cantidad,
                    cantidad_auto: !!cantidadDetectada
                });
                if (!cantidadDetectada) {
                    advertencias.push(`No se pudo confirmar la cantidad de "${prod.nombre}" en el PDF; se usó la base ${prod.cantidadBase}. Revísala antes de registrar.`);
                }
            }
        }

        if (itemsDetectados.length === 0) {
            const ptRes = await pool.query('SELECT * FROM producto_terminado');
            for (let pt of ptRes.rows) {
                const nombreBusq = pt.nombre_producto.toLowerCase().replace('aceite de soya', '').trim();
                if (!nombreBusq) continue;
                if (!textoPdf.toLowerCase().includes(nombreBusq)) continue;
                const cantidadDetectada = extraerCantidadPdf(textoPdf, [pt.nombre_producto, pt.nombre_producto.toLowerCase()]);
                if (cantidadDetectada) {
                    itemsDetectados.push({
                        product_key: pt.producto_key,
                        nombre: pt.nombre_producto,
                        cantidad: cantidadDetectada,
                        cantidad_auto: true
                    });
                } else {
                    advertencias.push(`Se detectó "${pt.nombre_producto}" en el PDF pero no se pudo leer su cantidad automáticamente. Agrégala manualmente en la lista.`);
                }
            }
        }

        res.json({
            success: true,
            datos: { numero_guia, ruc, empresa, destino, chofer_licencia, placa, items: itemsDetectados, advertencias }
        });
    } catch (err) {
        console.error("Error al leer PDF:", err);
        res.status(500).json({ success: false, mensaje: 'No se pudo leer el PDF: ' + err.message });
    }
});

// --- SALIDAS DE ALMACÉN ---
app.post('/api/salidas/registrar', upload.single('archivo_guia'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, fecha_salida, usuario, items_json } = req.body;
        const items = JSON.parse(items_json || '[]');

        if (items.length === 0) {
            return res.status(400).json({ success: false, mensaje: 'Debe incluir al menos un producto en el despacho.' });
        }

        await client.query('BEGIN');
        let estadoGuia = tipo_registro === 'CON GUIA' ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';
        let guiaFinal = numero_guia || 'S/N';

        for (const item of items) {
            let idArticuloFinal = item.articulo_id ? parseInt(item.articulo_id) : null;
            let productoKeyFinal = item.producto_key || null;

            if (productoKeyFinal) {
                await client.query(`UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE producto_key = $2`, [parseFloat(item.cantidad), productoKeyFinal]);
            } else if (idArticuloFinal) {
                await client.query(`UPDATE inventario SET stock = stock - $1 WHERE id = $2`, [parseFloat(item.cantidad), idArticuloFinal]);
                if (item.nombre) await actualizarEstadoArticulo(client, item.nombre);
            }

            let targetArticuloId = idArticuloFinal;
            if (!targetArticuloId && productoKeyFinal) {
                const matchInv = await client.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [item.nombre]);
                if (matchInv.rows.length > 0) targetArticuloId = matchInv.rows[0].id;
            }

            await client.query(`
                INSERT INTO salidas_almacen 
                (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, articulo_id, cantidad_salida, usuario_registro, estado_guia)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);
            `, [
                fecha_salida || new Date(), tipo_registro, guiaFinal, 
                empresa || 'N/A', ruc || 'N/A', destino || 'N/A', 
                chofer_licencia || 'N/A', placa || 'N/A', punto_partida || 'Almacén Principal', 
                targetArticuloId, item.cantidad, usuario || 'almacen_user', estadoGuia
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

app.post('/api/salidas/regularizar', async (req, res) => {
    try {
        const { salida_id, nuevo_numero_guia } = req.body;
        await pool.query(`UPDATE salidas_almacen SET numero_guia = $1, estado_guia = 'REGULARIZADO' WHERE id = $2`, [nuevo_numero_guia, salida_id]);
        res.json({ success: true, mensaje: 'Guía regularizada con éxito.' });
    } catch (err) {
        console.error("Error al regularizar guía:", err);
        res.status(500).json({ success: false, mensaje: 'Error al regularizar guía: ' + err.message });
    }
});

app.get('/api/salidas/historial', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, 
                   COALESCE(i.nombre, pt.nombre_producto, 'Producto General') as articulo_nombre, 
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

// --- AUDITORÍA Y PRODUCCIÓN ---
app.get('/api/auditoria/registros', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ingresos_vigilancia ORDER BY id DESC`);
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

function extraerTapaDeObservaciones(observaciones) {
    if (!observaciones || !observaciones.includes('Tapa:')) return null;
    const partes = observaciones.split('|');
    for (let parte of partes) {
        if (parte.includes('Tapa:')) return parte.replace('Tapa:', '').trim();
    }
    return null;
}

function safeParseJson(str) {
    try {
        return typeof str === 'string' ? JSON.parse(str) : str;
    } catch (e) {
        return null;
    }
}

app.post('/api/produccion/reporte', async (req, res) => {
    const { fecha_produccion, presentacion, cantidad_cajas, toneladas, observaciones, usuario } = req.body;
    try {
        const producto_tipo = detectarProductoTipo(presentacion);
        const tapa_elegida = extraerTapaDeObservaciones(observaciones);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const insumosADescontar = obtenerInsumosReceta(producto_tipo, cantidad_cajas, tapa_elegida);

            const faltantes = [];
            for (const insumo of insumosADescontar) {
                const stockRes = await client.query('SELECT stock FROM inventario WHERE LOWER(nombre) = LOWER($1)', [insumo.nombre]);
                const stockActual = stockRes.rows.length > 0 ? Number(stockRes.rows[0].stock || 0) : 0;
                if (stockActual < insumo.cantidad) {
                    faltantes.push(`${insumo.nombre}: requiere ${insumo.cantidad} | stock: ${stockActual}`);
                }
            }
            if (faltantes.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    mensaje: 'Stock insuficiente. No se registró nada:\n- ' + faltantes.join('\n- ')
                });
            }

            const desglose = [];
            for (const insumo of insumosADescontar) {
                const uRes = await client.query('SELECT unidad_medida, categoria FROM inventario WHERE LOWER(nombre) = LOWER($1)', [insumo.nombre]);
                desglose.push({
                    nombre: insumo.nombre,
                    cantidad: Number(insumo.cantidad),
                    unidad_medida: uRes.rows.length > 0 ? uRes.rows[0].unidad_medida : 'UNIDADES',
                    categoria: uRes.rows.length > 0 ? uRes.rows[0].categoria : ''
                });
            }
            const desgloseJson = JSON.stringify(desglose);

            for (const insumo of insumosADescontar) {
                await client.query(
                    `UPDATE inventario SET stock = stock - $1 WHERE LOWER(nombre) = LOWER($2)`,
                    [insumo.cantidad, insumo.nombre]
                );
                await actualizarEstadoArticulo(client, insumo.nombre);
            }

            if (producto_tipo) {
                const nombreLegible = PRODUCTOS_TERMINADOS_MAP[producto_tipo] || presentacion;
                await client.query(`
                    INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (producto_key) 
                    DO UPDATE SET stock_cajas = producto_terminado.stock_cajas + EXCLUDED.stock_cajas;
                `, [producto_tipo, nombreLegible, cantidad_cajas]);
            }

            await client.query(
                `INSERT INTO reportes_produccion (fecha_produccion, presentacion, cantidad_cajas, unidad_medida, toneladas, observaciones, usuario_registro, desglose_insumos) 
                 VALUES ($1, $2, $3, 'CAJAS', $4, $5, $6, $7)`,
                [fecha_produccion, presentacion, cantidad_cajas, toneladas, observaciones || '', usuario || 'envasado_user', desgloseJson]
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
                const tipo = detectarProductoTipo(inf.presentacion);
                if (tipo) {
                    const tapaElegida = extraerTapaDeObservaciones(inf.observaciones);
                    const insumos = obtenerInsumosReceta(tipo, parseInt(inf.cantidad_cajas, 10) || 0, tapaElegida);
                    inf.desglose = insumos.map(i => ({
                        nombre: i.nombre,
                        cantidad: Number(i.cantidad),
                        unidad_medida: 'UNIDADES',
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

app.post('/api/produccion/eliminar', async (req, res) => {
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

        const producto_tipo = detectarProductoTipo(reporte.presentacion);
        const tapa_elegida = extraerTapaDeObservaciones(reporte.observaciones);
        const cantidad_cajas = parseInt(reporte.cantidad_cajas, 10);

        if (producto_tipo) {
            const insumosADevolver = obtenerInsumosReceta(producto_tipo, cantidad_cajas, tapa_elegida);
            for (const insumo of insumosADevolver) {
                await client.query(
                    `UPDATE inventario SET stock = stock + $1 WHERE LOWER(nombre) = LOWER($2)`,
                    [insumo.cantidad, insumo.nombre]
                );
                await actualizarEstadoArticulo(client, insumo.nombre);
            }

            await client.query(
                `UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE producto_key = $2`,
                [cantidad_cajas, producto_tipo]
            );
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

app.post('/api/produccion/cierre', async (req, res) => {
    const client = await pool.connect();
    try {
        const { fecha_cierre, usuario } = req.body;
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

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});