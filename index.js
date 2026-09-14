const express = require('express');
const pool = require('./db');
const path = require('path');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const tesseract = require('tesseract.js');

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

// --- SEGURIDAD: TOKEN, HASH Y LIMITADOR DE LOGIN ---
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'belcen-clave-sesion-cambiar-en-produccion';
const TOKEN_DURACION_MS = 8 * 60 * 60 * 1000;
const scryptP = promisify(crypto.scrypt);

function hashPassword(password, salt) {
    return scryptP(password, salt, 64).then(buf => buf.toString('hex'));
}

function esPasswordHasheada(stored) {
    return typeof stored === 'string' && /^[a-f0-9]{128}:[a-f0-9]{32}$/.test(stored);
}

function generarToken(usuario, rol) {
    const payload = Buffer.from(JSON.stringify({ usuario, rol, exp: Date.now() + TOKEN_DURACION_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    return payload + '.' + sig;
}

function verificarToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const sigEsperado = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sigEsperado);
    const b = Buffer.from(sig);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    try {
        const datos = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!datos || Date.now() > datos.exp) return null;
        return datos;
    } catch (e) {
        return null;
    }
}

function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-token'] || '');
    const datos = verificarToken(token);
    if (!datos) {
        return res.status(401).json({ success: false, mensaje: 'Sesión no válida o expirada. Inicie sesión nuevamente.' });
    }
    req.usuario = datos.usuario;
    req.rol = datos.rol;
    next();
}

const intentosLogin = new Map();
function ipCliente(req) {
    const fwd = req.headers['x-forwarded-for'];
    return (fwd ? fwd.split(',')[0].trim() : (req.ip || 'local')).toString();
}
function loginBloqueado(req, usuario) {
    const clave = `${ipCliente(req)}|${usuario}`;
    const reg = intentosLogin.get(clave);
    return reg && reg.falla >= 5 && Date.now() < reg.hasta;
}
function registrarFalloLogin(req, usuario) {
    const clave = `${ipCliente(req)}|${usuario}`;
    const actual = intentosLogin.get(clave) || { falla: 0, hasta: 0 };
    const nuevo = { falla: actual.falla + 1, hasta: Date.now() + 5 * 60 * 1000 };
    intentosLogin.set(clave, nuevo);
    if (nuevo.falla >= 5) {
        console.warn(`⚠️ Intentos fallidos de login para ${usuario} desde ${ipCliente(req)}`);
    }
}
setInterval(() => {
    const ahora = Date.now();
    for (const [clave, reg] of intentosLogin) {
        if (reg.hasta < ahora) intentosLogin.delete(clave);
    }
}, 60 * 60 * 1000);

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const usu = String(usuario || '').trim();
        const pwd = String(password || '');

        if (!usu || !pwd) {
            return res.status(400).json({ success: false, mensaje: 'Ingrese usuario y contraseña.' });
        }
        if (loginBloqueado(req, usu)) {
            return res.status(429).json({ success: false, mensaje: 'Demasiados intentos fallidos. Espere 5 minutos.' });
        }

        const result = await pool.query('SELECT * FROM usuarios_sistema WHERE usuario = $1', [usu]);
        const user = result.rows[0];
        if (!user) {
            registrarFalloLogin(req, usu);
            return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos' });
        }

        let ok = false;
        if (esPasswordHasheada(user.password)) {
            const [hash, salt] = user.password.split(':');
            const calculado = await hashPassword(pwd, salt);
            ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calculado));
        } else {
            ok = user.password === pwd;
            if (ok) {
                const salt = crypto.randomBytes(16).toString('hex');
                const hash = await hashPassword(pwd, salt);
                await pool.query('UPDATE usuarios_sistema SET password = $1 WHERE id = $2', [`${hash}:${salt}`, user.id]);
            }
        }

        if (!ok) {
            registrarFalloLogin(req, usu);
            return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos' });
        }

        const token = generarToken(user.usuario, user.rol);
        res.json({ success: true, rol: user.rol, usuario: user.usuario, token });
    } catch (err) {
        console.error("Error en login:", err);
        res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
    }
});

app.use('/api', authMiddleware);

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

app.post('/api/almacen/conformidad-ajustada', async (req, res) => {
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
            const cantidadGuia = parseFloat(item.cantidad_guia);
            let estadoItem = 'CON GUIA';
            if (!isNaN(cantidadGuia) && cantidad !== cantidadGuia) {
                tieneDiferencias = true;
                estadoItem = 'POR REGULARIZAR';
            }

            const existeRes = await client.query('SELECT id FROM inventario WHERE LOWER(nombre) = LOWER($1)', [nombre]);
            let targetArticuloId;
            if (existeRes.rows.length > 0) {
                targetArticuloId = existeRes.rows[0].id;
                await client.query(
                    `UPDATE inventario SET stock = stock + $1 WHERE id = $2`,
                    [cantidad, targetArticuloId]
                );
            } else {
                const nuevoArt = await client.query(
                    `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado)
                     VALUES ($1, $2, $3, $4, CASE WHEN $3 <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END)
                     RETURNING id`,
                    [nombre, categoria, cantidad, unidad_medida]
                );
                targetArticuloId = nuevoArt.rows[0].id;
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

// --- ALMACÉN: CREAR NUEVO PRODUCTO EN INVENTARIO ---
app.post('/api/inventario/nuevo', async (req, res) => {
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

// Último número con sentido de una línea (quita separadores de miles y usa coma como decimal cuando aplica)
function ultimoNumeroLinea(linea) {
    const nums = (linea || '').match(/\d[\d.,]*/g);
    if (!nums || nums.length === 0) return null;
    for (let i = nums.length - 1; i >= 0; i--) {
        const raw = nums[i].replace(/,/g, '');
        if (/^\d+(\.\d+)?$/.test(raw)) {
            const v = parseFloat(raw);
            if (v > 0 && v < 100000) return v;
        }
    }
    return null;
}

// Claques de productos tal como aparecen en la guía de remisión electrónica SUNAT
const PRODUCTOS_PDF_KEYWORDS = [
    { product_key: 'b1_1lt', nombres: ['B-1 X 1 LT', 'B-1 X 1L', 'B-1 1 LT', 'B-1 1L'] },
    { product_key: 'b1_900ml', nombres: ['B-1 X 900 ML', 'B-1 900ML', 'B-1 900 ML'] },
    { product_key: 'b1_500ml', nombres: ['B-1 X 500 ML', 'B-1 500 ML'] },
    { product_key: 'b1_200ml', nombres: ['B-1 X 200 ML', 'B-1 200 ML'] },
    { product_key: 'b1_2lt', nombres: ['B-1 X 2 LT', 'B-1 2 LT', 'B-1 2L'] },
    { product_key: 'b1_5lt', nombres: ['B-1 X 5 LT', 'B-1 5 LT', 'B-1 5L'] },
    { product_key: 'donlalo_800ml', nombres: ['DON LALO X 800 ML', 'DON LALO 800ML', 'DON LALO 800 ML'] },
    { product_key: 'donlalo_20lt', nombres: ['DON LALO BALDE 20 LT', 'DON LALO 20 LT'] },
    { product_key: 'belini_1lt', nombres: ['BELINI X 1 LT', 'BELINI 1 LT', 'BELINI 1L'] },
    { product_key: 'belini_2lt', nombres: ['BELINI X 2 LT', 'BELINI 2 LT', 'BELINI 2L'] },
    { product_key: 'belini_900ml', nombres: ['BELINI X 900 ML', 'BELINI 900ML', 'BELINI 900 ML'] },
    { product_key: 'belini_500ml', nombres: ['BELINI X 500 ML', 'BELINI 500 ML'] },
    { product_key: 'belini_200ml', nombres: ['BELINI X 200 ML', 'BELINI 200 ML'] },
    { product_key: 'belini_3lt', nombres: ['BELINI X 3 LT', 'BELINI 3 LT'] },
    { product_key: 'belini_5lt', nombres: ['BELINI X 5 LT', 'BELINI 5 LT'] },
    { product_key: 'belini_lata18lt', nombres: ['BELINI LATA 18 LT', 'BELINI 18 LT'] },
    { product_key: 'belini_balde18lt', nombres: ['BELINI BALDE 18 LT'] }
];

// Lee la tabla "Bienes por transportar" de la guía SUNAT (una fila por producto, cantidad al final)
function detectarItemsTabla(textoPdf) {
    const lineas = textoPdf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const idxIni = lineas.findIndex(l => /Bienes por [Tt]ransportar/i.test(l));
    const idxFin = lineas.findIndex(l => /Indicador de traslado|Datos del traslado|Datos de los veh[ií]culos|Datos de los conductores|representaci[óo]n impresa/i.test(l));
    const region = idxIni !== -1 ? lineas.slice(idxIni + 1, idxFin !== -1 ? idxFin : lineas.length) : lineas;

    const items = [];
    const advertencias = [];
    const emparejados = new Set();
    let noReconocidas = 0;

    for (const linea of region) {
        if (linea.length < 10) continue;
        if (/Peso Bruto|KGM|Indicador|Documentos|Observaci|^NO$|Bien normalizado|Descripci[oó]n Detallada|Partida arancelaria|Unidad de medida|^TOTAL|Datos del traslado|Número de|Principal:|Secundario|Habiltaci|TUCE|Certificado de|de la carga:|^normalizado|^medida$|^Cantidad$|^C[óo]digo$|^GTIN$|^SUNAT$|^Bien$|^Descripci|^Partida$/i.test(linea)) continue;
        const normLinea = normalizarGuia(linea);
        if (!normLinea || normLinea.length < 15) continue;

        const cantidad = ultimoNumeroLinea(linea);
        let reconocida = false;
        for (const prod of PRODUCTOS_PDF_KEYWORDS) {
            if (emparejados.has(prod.product_key)) continue;
            if (prod.nombres.some(n => normLinea.includes(normalizarGuia(n)))) {
                reconocida = true;
                emparejados.add(prod.product_key);
                const nombre = PRODUCTOS_TERMINADOS_MAP[prod.product_key] || prod.product_key;
                items.push({ product_key: prod.product_key, nombre, cantidad, cantidad_auto: cantidad !== null });
                if (cantidad === null) {
                    advertencias.push(`Se detectó "${nombre}" en el PDF sin una cantidad clara. Revísala en la lista.`);
                }
                break;
            }
        }
        if (!reconocida) {
            noReconocidas++;
            if (noReconocidas <= 5) {
                advertencias.push(`Línea del PDF sin reconocer (revísala): "${linea.slice(0, 80)}..."`);
            }
        }
    }
    return { items, advertencias };
}

// Extrae las direcciones de partida y llegada de la guía SUNAT (bloque antes de "Punto de ...")
function extraerDireccionSUNAT(lineas) {
    const finAddr = /-\s*([A-ZÁÉÍÓÚÑÜ]{3,})\s+-\s+([A-ZÁÉÍÓÚÑÜ\s]{3,}?)\s*$/i;
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
    const inicio = idxStart !== -1 ? idxStart + 1 : 0;
    for (let i = inicio; i < idxLabel; i++) {
        let l = lineas[i].replace(/^Venta\s+/i, '').trim();
        if (l.length < 8 || !/[A-ZÁÉÍÓÚÑÜ]/.test(l)) continue;
        if (/^\d{1,2}\/\d{1,2}\/\d{4}\s*$/.test(l)) continue;
        if (/[:]/.test(l) && !/-/.test(l)) continue;
        buf = buf ? buf + ' ' + l : l;
        if (finAddr.test(buf)) {
            direcciones.push(buf.trim());
            buf = '';
        }
    }
    if (buf.trim() && direcciones.length < 2) direcciones.push(buf.trim());

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

    let m = textoPdf.match(/N[°º\.]?\s*([A-Z0-9]{2,8})\s*[-–]\s*(\d{4,8})/i);
    if (m) {
        res.numero_guia = (m[1] + '-' + m[2]).toUpperCase();
    } else {
        m = textoPdf.match(/([T|F|B]\s*0\d{2}\s*[-]\s*\d{1,8})/i);
        if (m) res.numero_guia = m[1].replace(/\s+/g, '').toUpperCase();
    }

    m = textoPdf.match(/Datos del\s+[Dd]estinatario\s*:?\s*(.+?)\s*-\s*REGISTRO\s*ÚNICO\s*DE\s*CONTRIBUYENTES\s*N[°º]?\s*(\d{11})/i);
    if (m) {
        res.empresa = m[1].trim();
        res.ruc = m[2];
    }

    if (!res.ruc) {
        m = textoPdf.match(/RUC\s*N[°º]?\s*(\d{11})/i);
        if (m) res.ruc = m[1];
    }
    if (!res.empresa) {
        const seg = textoPdf.match(/N[°º\.]\s*[A-Z]{1,4}\s*[-–]\s*\d{4,8}\s*\r?\n+\s*([A-ZÁÉÍÓÚÑÜ0-9.& ]{4,60})/i);
        if (seg) res.empresa = seg[1].trim();
    }
    if (!res.empresa) {
        const seg2 = textoPdf.match(/Datos del\s+[Rr]emitente\s*:?\s*(.+?)\s*-\s*(?:REGISTRO\s*ÚNICO\s*DE\s*CONTRIBUYENTES|RUC)\s*N[°º]?\s*(\d{11})/);
        if (seg2) res.empresa = seg2[1].trim();
    }

    const dirs = extraerDireccionSUNAT(lineas);
    res.punto_partida = dirs.partida;
    res.destino = dirs.llegada;
    if (!res.destino) {
        const lleg = textoPdf.match(/P\.?Llegada[:\s]*[\d\s-]+(.*)/i);
        if (lleg) res.destino = lleg[1].trim();
        else {
            const dir = textoPdf.match(/Direcci[oó]n[:\s]*(.*)/i);
            if (dir) res.destino = dir[1].trim();
        }
    }

    let pm = textoPdf.match(/Número de placa[^\n]*Principal[:\s]+([A-Z0-9][A-Z0-9\-]*[0-9])/i);
    if (!pm) pm = textoPdf.match(/Principal[:\s]+([A-Z0-9][A-Z0-9\-]*[0-9])/i);
    if (!pm) pm = textoPdf.match(/(?:placa|veh[ií]culo)[^\w]*([A-Z0-9][A-Z0-9\-]+)/i);
    if (pm) res.placa = pm[1].trim().toUpperCase();

    let cm = textoPdf.match(/Principal[:\s]+([A-ZÁÉÍÓÚÑÜ .]{3,}?)\s*-\s*DOCUMENTO NACIONAL/i);
    if (!cm) cm = textoPdf.match(/Conductor[:\s]*([A-ZÁÉÍÓÚÑÜ .]{3,}?)(?=\s*(?:DNI|Licencia|LIC|Brevete|Placa|Veh[ií]culo|RUC)[:\s]|$)/i);
    if (cm) res.chofer = cm[1].trim().replace(/\s+/g, ' ');

    let lm = textoPdf.match(/Número de lincencia de conducir[:\s]*([A-Z0-9][A-Z0-9\-]*[0-9])/i)
        || textoPdf.match(/Número de licencia de conducir[:\s]*([A-Z0-9][A-Z0-9\-]*[0-9])/i)
        || textoPdf.match(/Licencia[:\s]*([A-Z0-9][A-Z0-9\-]*[0-9])/i);
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

// --- LECTOR INTELIGENTE DE PDF PARA SALIDAS ---
app.post('/api/salidas/leer-pdf', upload.single('archivo_guia'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, mensaje: 'No se subió ningún archivo PDF.' });
        }

        const dataBuffer = fs.readFileSync(req.file.path);
        const pdfData = await new PDFParse({ data: dataBuffer }).getText();
        let textoPdf = pdfData.text || '';
        let metodo = 'texto';

        const esEscaneo = textoPdf.trim().length < 30;
        if (esEscaneo) {
            try {
                const textoOCR = await ocrPdf(dataBuffer);
                if (textoOCR.trim().length < 15) {
                    return res.json({ success: false, mensaje: 'El PDF es un escaneo (imagen) y no se pudo reconocer su contenido por OCR. Carga los datos manualmente.' });
                }
                textoPdf = textoOCR;
                metodo = 'ocr';
            } catch (err) {
                console.error('Error OCR:', err);
                return res.json({ success: false, mensaje: 'El PDF parecía un escaneo y el OCR falló (' + err.message + '). Carga los datos manualmente.' });
            }
        }

        const cabecera = parsearCabeceraSUNAT(textoPdf);
        const chofer_licencia = [cabecera.chofer, cabecera.licencia ? 'Lic: ' + cabecera.licencia : ''].filter(Boolean).join(' - ');

        const { items: itemsTabla, advertencias: advertenciasTabla } = detectarItemsTabla(textoPdf);
        let itemsDetectados = itemsTabla;
        const advertencias = advertenciasTabla.slice();

        if (itemsDetectados.length === 0) {
            const ptRes = await pool.query('SELECT * FROM producto_terminado');
            for (let pt of ptRes.rows) {
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
    }
});

// --- SALIDAS DE ALMACÉN ---
app.post('/api/salidas/registrar', upload.single('archivo_guia'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, fecha_salida, usuario, items_json } = req.body;
        const items = JSON.parse(items_json || '[]');
        const despachoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

        if (items.length === 0) {
            return res.status(400).json({ success: false, mensaje: 'Debe incluir al menos un producto en el despacho.' });
        }

        await client.query('BEGIN');
        let estadoGuia = tipo_registro === 'CON GUIA' ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';
        let guiaFinal = numero_guia || 'S/N';
        const guia_url = req.file ? `/uploads/${req.file.filename}` : null;

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
                (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, articulo_id, cantidad_salida, usuario_registro, estado_guia, guia_url, despacho_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);
            `, [
                fecha_salida || new Date(), tipo_registro, guiaFinal, 
                empresa || 'N/A', ruc || 'N/A', destino || 'N/A', 
                chofer_licencia || 'N/A', placa || 'N/A', punto_partida || 'Almacén Principal', 
                targetArticuloId, item.cantidad, usuario || 'almacen_user', estadoGuia, guia_url, despachoId
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

app.post('/api/salidas/eliminar', async (req, res) => {
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
                await client.query(`UPDATE producto_terminado SET stock_cajas = stock_cajas + $1 WHERE producto_key = $2`, [cantidad, fila.producto_key]);
            } else if (fila.articulo_id) {
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidad, fila.articulo_id]);
                const nombreRow = await client.query('SELECT nombre FROM inventario WHERE id = $1', [fila.articulo_id]);
                if (nombreRow.rows.length > 0) await actualizarEstadoArticulo(client, nombreRow.rows[0].nombre);
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

app.post('/api/salidas/editar', upload.single('archivo_guia'), async (req, res) => {
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
                await client.query(`UPDATE producto_terminado SET stock_cajas = stock_cajas + $1 WHERE producto_key = $2`, [cantidad, fila.producto_key]);
            } else if (fila.articulo_id) {
                await client.query(`UPDATE inventario SET stock = stock + $1 WHERE id = $2`, [cantidad, fila.articulo_id]);
                const nombreRow = await client.query('SELECT nombre FROM inventario WHERE id = $1', [fila.articulo_id]);
                if (nombreRow.rows.length > 0) await actualizarEstadoArticulo(client, nombreRow.rows[0].nombre);
            }
            await client.query('DELETE FROM salidas_almacen WHERE id = $1', [fila.id]);
        }

        const estadoGuia = tipo_registro === 'CON GUIA' ? 'REGULARIZADO' : 'PENDIENTE REGULARIZAR';
        const guiaFinal = numero_guia || 'S/N';
        const guia_url = req.file ? `/uploads/${req.file.filename}` : (filas[0].guia_url || null);

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
                (fecha_salida, tipo_registro, numero_guia, empresa, ruc, destino, chofer_licencia, placa, punto_partida, articulo_id, cantidad_salida, usuario_registro, estado_guia, guia_url, despacho_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);
            `, [
                fecha_salida || new Date(), tipo_registro, guiaFinal,
                empresa || 'N/A', ruc || 'N/A', destino || 'N/A',
                chofer_licencia || 'N/A', placa || 'N/A', punto_partida || 'Almacén Principal',
                targetArticuloId, item.cantidad, usuario || 'almacen_user', estadoGuia, guia_url, despacho_id
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

// --- AUDITORÍA: ENTRADAS (VIGILANCIA + ALMACÉN) Y SALIDAS ---
app.get('/api/auditoria/entradas', async (req, res) => {
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

app.get('/api/auditoria/salidas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*,
                   COALESCE(i.nombre, pt.nombre_producto, 'Producto General') as articulo_nombre
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

module.exports = { app, parsearCabeceraSUNAT, detectarItemsTabla, extraerDireccionSUNAT };