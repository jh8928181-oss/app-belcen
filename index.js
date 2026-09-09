const express = require('express');
const pool = require('./db');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');

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

// --- VIGILANCIA ---
app.post('/api/vigilancia/registrar', upload.single('foto_guia'), async (req, res) => {
    try {
        const { tipo_documento, numero_guia, proveedor, lugar_partida, punto_llegada, producto_textual, cantidad, unidad_medida, usuario } = req.body;
        const foto_url = req.file ? `/uploads/${req.file.filename}` : null;

        const query = `
            INSERT INTO ingresos_vigilancia (tipo_documento, numero_guia, proveedor, lugar_partida, punto_llegada, producto_textual, cantidad, unidad_medida, foto_url, usuario_vigilancia, estado)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDIENTE CONFORMIDAD') RETURNING *;
        `;
        const values = [tipo_documento, numero_guia, proveedor, lugar_partida, punto_llegada, producto_textual, cantidad || 0, unidad_medida, foto_url, usuario];
        
        const nuevoIngreso = await pool.query(query, values);
        res.json({ success: true, mensaje: 'Ingreso registrado por vigilancia correctamente', ingreso: nuevoIngreso.rows[0] });
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
        const { ingreso_id, articulo_id_inventario, nombre_manual, usuario_almacen } = req.body;
        await client.query('BEGIN');

        const ingresoRes = await client.query('SELECT * FROM ingresos_vigilancia WHERE id = $1', [ingreso_id]);
        const ingreso = ingresoRes.rows[0];

        let targetArticuloId = articulo_id_inventario;

        if (!targetArticuloId && nombre_manual) {
            const existeRes = await client.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [nombre_manual]);
            if (existeRes.rows.length > 0) {
                targetArticuloId = existeRes.rows[0].id;
            } else {
                const nuevoArt = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) VALUES ($1, 'General', 0, 'UNIDADES', 'STOCK SUFICIENTE') RETURNING id`,
                    [nombre_manual]
                );
                targetArticuloId = nuevoArt.rows[0].id;
            }
        }

        await client.query(
            `UPDATE inventario SET stock = stock + $1 WHERE id = $2`,
            [ingreso.cantidad, targetArticuloId]
        );

        await client.query(
            `UPDATE ingresos_vigilancia SET estado = 'CONFORME - RECIBIDO POR ${usuario_almacen}' WHERE id = $1`,
            [ingreso_id]
        );

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Conformidad aplicada y stock actualizado exitosamente.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error en conformidad:", err);
        res.status(500).json({ success: false, mensaje: 'Error al procesar conformidad: ' + err.message });
    } finally {
        client.release();
    }
});

// --- ALMACÉN: AJUSTE MANUAL DE INVENTARIO INSUMOS ---
app.post('/api/almacen/ajustar-stock', async (req, res) => {
    try {
        const { articulo_id, nuevo_stock } = req.body;
        
        await pool.query(
            `UPDATE inventario 
             SET stock = $1, 
                 estado = CASE WHEN $1 <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END 
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

// --- SOPLADO ---
app.post('/api/soplado/registrar', async (req, res) => {
    const client = await pool.connect();
    try {
        const { preforma_id, cantidad_preformas, etiqueta_id, cantidad_etiquetas, botella_id, cantidad_botellas } = req.body;

        await client.query('BEGIN');

        if (preforma_id && cantidad_preformas) {
            await client.query(`UPDATE inventario SET stock = stock - $1 WHERE id = $2`, [cantidad_preformas, preforma_id]);
        }
        if (etiqueta_id && cantidad_etiquetas) {
            await client.query(`UPDATE inventario SET stock = stock - $1 WHERE id = $2`, [cantidad_etiquetas, etiqueta_id]);
        }
        if (botella_id && cantidad_botellas) {
            await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidad_botellas, botella_id]);
        }

        await client.query('COMMIT');
        res.json({ success: true, mensaje: 'Producción de soplado registrada y stock actualizado correctamente.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al registrar soplado:', error);
        res.status(500).json({ success: false, mensaje: 'Error al procesar el reporte de soplado: ' + error.message });
    } finally {
        client.release();
    }
});

// --- ENVASADO: DESCUENTO DE INSUMOS + SUMA A PRODUCTO TERMINADO ---
app.post('/api/envasado/registrar', async (req, res) => {
    const client = await pool.connect();
    try {
        const { producto_tipo, cantidad_producida, numero_lote, tapa_elegida } = req.body; 
        await client.query('BEGIN');

        let insumosADescontar = [];
        // Tapa seleccionada manualmente o tapa por defecto
        const tapaProceso = tapa_elegida || 'Tapa dosif. N° 26 blanco / Dorado';

        switch (producto_tipo) {
            case 'b1_200ml':
                insumosADescontar = [
                    { nombre: 'Botella de 200 ml - B-1', cantidad: cantidad_producida * 24 },
                    { nombre: 'Tapa Tapon 26mm (200ml)', cantidad: (cantidad_producida * 24) / 1000 }
                ];
                break;
            case 'b1_500ml':
                insumosADescontar = [
                    { nombre: 'Botella de 500 ml - B-1', cantidad: cantidad_producida * 12 },
                    { nombre: tapaProceso, cantidad: (cantidad_producida * 12) / 1000 }
                ];
                break;
            case 'b1_900ml':
                insumosADescontar = [
                    { nombre: 'Botella de 900 ml - B-1', cantidad: cantidad_producida * 12 },
                    { nombre: tapaProceso, cantidad: (cantidad_producida * 12) / 1000 }
                ];
                break;
            case 'b1_1lt':
                insumosADescontar = [
                    { nombre: 'Botella de 1 Lt - B-1', cantidad: cantidad_producida * 12 },
                    { nombre: tapaProceso, cantidad: (cantidad_producida * 12) / 1000 }
                ];
                break;
            case 'b1_2lt':
                insumosADescontar = [
                    { nombre: 'Botella de 2 Lt - B-1', cantidad: cantidad_producida * 6 },
                    { nombre: 'Tapa color Rojo 2lt', cantidad: (cantidad_producida * 6) / 1000 }
                ];
                break;
            case 'b1_5lt':
                insumosADescontar = [
                    { nombre: 'Galonera B-1 x 5 lt', cantidad: cantidad_producida * 4 },
                    { nombre: 'Tapa color rojo 5lt', cantidad: (cantidad_producida * 4) / 1000 }
                ];
                break;
            case 'donlalo_800ml':
                insumosADescontar = [
                    { nombre: 'Botella de 800ml - Don Lalo', cantidad: cantidad_producida * 12 },
                    { nombre: 'Tapa dosif. N° 26 blanco / Dorado', cantidad: (cantidad_producida * 12) / 1000 }
                ];
                break;
            case 'donlalo_20lt':
                insumosADescontar = [
                    { nombre: 'Balde Don Lalo x 20lt', cantidad: cantidad_producida * 1 },
                    { nombre: 'TAAAAPA BALDE DON LALO', cantidad: cantidad_producida * 1 }
                ];
                break;
            case 'belini_200ml':
                insumosADescontar = [
                    { nombre: 'Botella Belini x 200 ml', cantidad: cantidad_producida * 24 },
                    { nombre: 'Tapa Tapon 26mm (200ml)', cantidad: (cantidad_producida * 24) / 1000 }
                ];
                break;
            case 'belini_500ml':
                insumosADescontar = [
                    { nombre: 'Botella Belini x 500 ml', cantidad: cantidad_producida * 12 },
                    { nombre: tapaProceso, cantidad: (cantidad_producida * 12) / 1000 }
                ];
                break;
            case 'belini_900ml':
                insumosADescontar = [
                    { nombre: 'Botella Belini x 900 ml', cantidad: cantidad_producida * 12 },
                    { nombre: tapaProceso, cantidad: (cantidad_producida * 12) / 1000 }
                ];
                break;
            case 'belini_1lt':
                insumosADescontar = [
                    { nombre: 'Botella Belini x 1 Lt', cantidad: cantidad_producida * 12 },
                    { nombre: tapaProceso, cantidad: (cantidad_producida * 12) / 1000 }
                ];
                break;
            case 'belini_2lt':
                insumosADescontar = [
                    { nombre: 'Galonera Belini x 2 lt', cantidad: cantidad_producida * 6 },
                    { nombre: 'Tapa color Rojo 2lt', cantidad: (cantidad_producida * 6) / 1000 }
                ];
                break;
            case 'belini_3lt':
                insumosADescontar = [
                    { nombre: 'Botella Belini x 3 lt', cantidad: cantidad_producida * 4 },
                    { nombre: 'Tapa color Celeste 3lt', cantidad: (cantidad_producida * 4) / 1000 },
                    { nombre: 'Asas plasticas color celeste pico 45', cantidad: (cantidad_producida * 4) / 1000 }
                ];
                break;
            case 'belini_5lt':
                insumosADescontar = [
                    { nombre: 'Galonera Belini x 5 lt', cantidad: cantidad_producida * 4 },
                    { nombre: 'Tapa color rojo 5lt', cantidad: (cantidad_producida * 4) / 1000 }
                ];
                break;
            case 'belini_lata18lt':
                insumosADescontar = [
                    { nombre: 'Lata Belini 18lt', cantidad: cantidad_producida * 1 }
                ];
                break;
            case 'belini_balde18lt':
                insumosADescontar = [
                    { nombre: 'Balde Belini x 18 lt', cantidad: cantidad_producida * 1 },
                    { nombre: 'Tapa BALDE BELINI color amarillo', cantidad: cantidad_producida * 1 }
                ];
                break;
            default:
                throw new Error('Tipo de producto desconocido para la receta de envasado.');
        }

        // Descontar insumos del inventario
        for (const insumo of insumosADescontar) {
            await client.query(
                `UPDATE inventario SET stock = stock - $1 WHERE LOWER(nombre) = LOWER($2)`,
                [insumo.cantidad, insumo.nombre]
            );
        }

        // Sumar cajas producidas a la tabla producto_terminado
        const nombreLegible = PRODUCTOS_TERMINADOS_MAP[producto_tipo] || producto_tipo;
        await client.query(`
            INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas)
            VALUES ($1, $2, $3)
            ON CONFLICT (producto_key) 
            DO UPDATE SET stock_cajas = producto_terminado.stock_cajas + EXCLUDED.stock_cajas;
        `, [producto_tipo, nombreLegible, cantidad_producida]);

        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Producción del lote ${numero_lote} registrada (+${cantidad_producida} cajas a Producto Terminado). Insumo de tapa "${tapaProceso}" descontado.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en registro de envasado:', error);
        res.status(500).json({ success: false, mensaje: 'Error al procesar la producción de envasado: ' + error.message });
    } finally {
        client.release();
    }
});

// --- SALIDAS DE ALMACÉN ---
app.post('/api/salidas/registrar', upload.single('archivo_guia'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            tipo_registro, numero_guia, empresa, ruc, destino, 
            chofer_licencia, placa, punto_partida, articulo_id, producto_key,
            cantidad_salida, fecha_salida, usuario 
        } = req.body;

        await client.query('BEGIN');

        let guiaFinal = numero_guia || '';
        let empresaFinal = empresa;
        let rucFinal = ruc;
        let estadoGuia = tipo_registro === 'CON GUIA' ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';

        if (tipo_registro === 'CON GUIA' && req.file) {
            const fs = require('fs');
            const dataBuffer = fs.readFileSync(req.file.path);
            const pdfData = await pdfParse(dataBuffer);
            const textoPdf = pdfData.text;

            const guiaMatch = textoPdf.match(/(?:[F|B]\d{3}-\d{1,8})|(?:\bGUIA\b[\s\S]{0,15}(\d{3,4}-\d{4,8}))/i);
            if (guiaMatch) {
                guiaFinal = guiaMatch[1] || guiaMatch[0];
            }

            const rucMatch = textoPdf.match(/\b(20\d{9})\b/);
            if (rucMatch) rucFinal = rucMatch[1];
            if (!empresaFinal) empresaFinal = "Extraído de PDF";
        }

        let idArticuloFinal = articulo_id ? parseInt(articulo_id) : null;

        // Si la salida es un Producto Terminado (Cajas)
        if (producto_key) {
            await client.query(
                `UPDATE producto_terminado SET stock_cajas = stock_cajas - $1 WHERE producto_key = $2`,
                [parseFloat(cantidad_salida), producto_key]
            );
        } else if (idArticuloFinal) {
            // Si es un insumo suelto de la tabla inventario
            await client.query(
                `UPDATE inventario SET stock = stock - $1 WHERE id = $2`,
                [parseFloat(cantidad_salida), idArticuloFinal]
            );
        }

        const querySalida = `
            INSERT INTO salidas_almacen 
            (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, articulo_id, producto_key, cantidad_salida, usuario_registro, estado_guia)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *;
        `;
        const valoresSalida = [
            fecha_salida || new Date(), tipo_registro, guiaFinal || 'S/N', 
            empresaFinal || 'N/A', rucFinal || 'N/A', destino || 'N/A', 
            chofer_licencia || 'N/A', placa || 'N/A', punto_partida || 'Almacén Principal', 
            idArticuloFinal, producto_key || null, cantidad_salida, usuario || 'almacen_user', estadoGuia
        ];

        const resultadoSalida = await client.query(querySalida, valoresSalida);
        await client.query('COMMIT');

        res.json({ success: true, mensaje: 'Salida registrada correctamente y stock descontado.', salida: resultadoSalida.rows[0] });
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
        await pool.query(
            `UPDATE salidas_almacen SET numero_guia = $1, estado_guia = 'REGULARIZADO' WHERE id = $2`,
            [nuevo_numero_guia, salida_id]
        );
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
        res.status(500).json({ success: false, mensaje: 'Error al obtener el historial de salidas: ' + err.message });
    }
});

// --- AUDITORÍA ---
app.get('/api/auditoria/registros', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, tipo_documento, numero_guia, proveedor, lugar_partida, 
                   punto_llegada, producto_textual, cantidad, unidad_medida, 
                   foto_url, usuario_vigilancia, estado, fecha_ingreso
            FROM ingresos_vigilancia 
            ORDER BY id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Error en auditoria:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener los registros de auditoría: ' + err.message });
    }
});

// --- REPORTE DE PRODUCCIÓN ---
app.post('/api/produccion/reporte', async (req, res) => {
    const { fecha_produccion, presentacion, cantidad_cajas, toneladas, observaciones, usuario } = req.body;
    try {
        await pool.query(
            `INSERT INTO reportes_produccion (fecha_produccion, presentacion, cantidad_cajas, unidad_medida, toneladas, observaciones, usuario_registro) 
             VALUES ($1, $2, $3, 'CAJAS', $4, $5, $6)`,
            [fecha_produccion, presentacion, cantidad_cajas, toneladas, observaciones || '', usuario || 'envasado_user']
        );
        res.json({ success: true, mensaje: 'Reporte registrado correctamente' });
    } catch (err) {
        console.error("Error en reporte producción:", err);
        res.status(500).json({ success: false, mensaje: 'Error al registrar el reporte de producción: ' + err.message });
    }
});

app.get('/api/produccion/reportes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reportes_produccion ORDER BY id DESC LIMIT 20');
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener reportes:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener los reportes: ' + err.message });
    }
});

// --- CIERRE DE PRODUCCIÓN ---
app.post('/api/produccion/cierre', async (req, res) => {
    const client = await pool.connect();
    try {
        const { fecha_cierre, usuario } = req.body;
        await client.query('BEGIN');

        const resumen = await client.query(
            `SELECT SUM(cantidad_cajas) as total_cajas, SUM(toneladas) as total_tn, COUNT(*) as total_registros 
             FROM reportes_produccion WHERE fecha_produccion = $1`,
            [fecha_cierre]
        );

        if (resumen.rows[0].total_registros == 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, mensaje: 'No hay registros de producción para cerrar en esta fecha.' });
        }

        const { total_cajas, total_tn } = resumen.rows[0];

        await client.query(
            `INSERT INTO historial_cierres_produccion (fecha_cierre, total_cajas, total_toneladas, usuario_cierre) 
             VALUES ($1, $2, $3, $4)`,
            [fecha_cierre, total_cajas || 0, total_tn || 0, usuario || 'envasado_user']
        );

        await client.query(`DELETE FROM reportes_produccion WHERE fecha_produccion = $1`, [fecha_cierre]);

        await client.query('COMMIT');
        res.json({ success: true, mensaje: `Cierre de producción del ${fecha_cierre} realizado con éxito. Cuadro reiniciado.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error en cierre:", err);
        res.status(500).json({ success: false, mensaje: 'Error al procesar el cierre de producción: ' + err.message });
    } finally {
        client.release();
    }
});

app.get('/api/produccion/historial-cierres', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM historial_cierres_produccion ORDER BY fecha_cierre DESC');
        res.json(result.rows);
    } catch (err) {
        console.error("Error en historial cierres:", err);
        res.status(500).json({ success: false, mensaje: 'Error al obtener el historial de cierres: ' + err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});