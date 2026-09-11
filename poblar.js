const pool = require('./db');

async function poblarInventarioReal() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Limpiar tablas existentes
        await client.query('DROP TABLE IF EXISTS inventario CASCADE;');
        await client.query('DROP TABLE IF EXISTS producto_terminado CASCADE;');
        await client.query('DROP TABLE IF EXISTS usuarios_sistema CASCADE;');
        await client.query('DROP TABLE IF EXISTS ingresos_vigilancia CASCADE;');
        await client.query('DROP TABLE IF EXISTS registro_ingresos_almacen CASCADE;');
        await client.query('DROP TABLE IF EXISTS salidas_almacen CASCADE;');
        await client.query('DROP TABLE IF EXISTS reportes_produccion CASCADE;');
        await client.query('DROP TABLE IF EXISTS historial_cierres_produccion CASCADE;');

        // 2. Crear tabla inventario
        await client.query(`
            CREATE TABLE inventario (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(150) UNIQUE NOT NULL,
                categoria VARCHAR(100) NOT NULL,
                stock NUMERIC(10,2) NOT NULL DEFAULT 0,
                unidad_medida VARCHAR(50) DEFAULT 'UNIDADES',
                estado VARCHAR(50) DEFAULT 'STOCK SUFICIENTE'
            );
        `);

        // 3. Crear tabla producto_terminado
        await client.query(`
            CREATE TABLE producto_terminado (
                id SERIAL PRIMARY KEY,
                producto_key VARCHAR(100) UNIQUE NOT NULL,
                nombre_producto VARCHAR(150) NOT NULL,
                stock_cajas INT DEFAULT 0
            );
        `);

        // 4. Crear usuarios y sembrarlos
        await client.query(`
            CREATE TABLE usuarios_sistema (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                rol VARCHAR(30) NOT NULL
            );

            INSERT INTO usuarios_sistema (usuario, password, rol) VALUES 
            ('vigilancia1', 'belcen2026*', 'vigilancia'),
            ('almacen1', 'almacenpass1', 'almacen'),
            ('soplado_user', 'soplado123', 'soplado'),
            ('envasado_user', 'envasado123', 'envasado'),
            ('auditor_user', 'auditor123', 'auditoria')
            ON CONFLICT (usuario) DO NOTHING;
        `);

        // 5. Crear tablas operativas (Vigilancia actualizada con chofer, dni, placa y observaciones)
        await client.query(`
            CREATE TABLE ingresos_vigilancia (
                id SERIAL PRIMARY KEY,
                tipo_documento VARCHAR(50),
                numero_guia VARCHAR(100),
                proveedor VARCHAR(150),
                chofer VARCHAR(150),
                dni_chofer VARCHAR(50),
                placa VARCHAR(50),
                lugar_partida VARCHAR(150),
                punto_llegada VARCHAR(150),
                observaciones TEXT,
                foto_url TEXT,
                usuario_vigilancia VARCHAR(50),
                items_json TEXT,
                estado VARCHAR(100) DEFAULT 'PENDIENTE CONFORMIDAD',
                fecha_ingreso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE registro_ingresos_almacen (
                id SERIAL PRIMARY KEY,
                fecha_registro DATE DEFAULT CURRENT_DATE,
                numero_guia VARCHAR(100),
                proveedor VARCHAR(150),
                producto_nombre VARCHAR(150),
                cantidad NUMERIC(10,2),
                estado VARCHAR(50),
                articulo_id INT REFERENCES inventario(id)
            );

            CREATE TABLE salidas_almacen (
                id SERIAL PRIMARY KEY,
                fecha_salida DATE DEFAULT CURRENT_DATE,
                tipo_registro VARCHAR(30) NOT NULL,
                numero_guia VARCHAR(100),
                empresa VARCHAR(150),
                ruc VARCHAR(20),
                destino VARCHAR(150),
                chofer_licencia VARCHAR(150),
                placa VARCHAR(50),
                punto_partida VARCHAR(150),
                articulo_id INT REFERENCES inventario(id),
                cantidad_salida NUMERIC(10,2) NOT NULL,
                usuario_registro VARCHAR(50),
                estado_guia VARCHAR(50),
                producto_key VARCHAR(50),
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE reportes_produccion (
                id SERIAL PRIMARY KEY,
                fecha_produccion DATE NOT NULL,
                presentacion VARCHAR(150) NOT NULL,
                cantidad_cajas INT NOT NULL,
                unidad_medida VARCHAR(20) DEFAULT 'CAJAS',
                toneladas NUMERIC(10,2) NOT NULL,
                observaciones TEXT,
                usuario_registro VARCHAR(50),
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE historial_cierres_produccion (
                id SERIAL PRIMARY KEY,
                fecha_cierre DATE NOT NULL,
                total_cajas NUMERIC(10,2) NOT NULL,
                total_toneladas NUMERIC(10,2) NOT NULL,
                usuario_cierre VARCHAR(50),
                detalle_json TEXT,
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 6. Insertar datos de inventario
        const queryInsert = `
            INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) 
            VALUES ($1, $2, $3, $4, $5);
        `;

        const articulos = [
            // BOTELLAS Y GALONERAS
            ['Botella de 200 ml - B-1', 'BOTELLAS Y GALONERAS', 25274, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Botella de 500 ml - B-1', 'BOTELLAS Y GALONERAS', 10906, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Botella de 900 ml - B-1', 'BOTELLAS Y GALONERAS', 6126, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Botella de 1 Lt - B-1', 'BOTELLAS Y GALONERAS', 30977, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Botella de 2 Lt - B-1', 'BOTELLAS Y GALONERAS', 665, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Galonera B-1 x 5 lt', 'BOTELLAS Y GALONERAS', 1438, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Botella de 800ml - Don Lalo', 'BOTELLAS Y GALONERAS', 0, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Botella Belini x 3 lt', 'BOTELLAS Y GALONERAS', 1352, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Botella Belini x 200 ml', 'BOTELLAS Y GALONERAS', 0, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Botella Belini x 500 ml', 'BOTELLAS Y GALONERAS', 19374, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Botella Belini x 900 ml', 'BOTELLAS Y GALONERAS', 44137, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Botella Belini x 1 Lt', 'BOTELLAS Y GALONERAS', 5368, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Galonera Belini x 2 lt', 'BOTELLAS Y GALONERAS', 0, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Galonera Belini x 5 lt', 'BOTELLAS Y GALONERAS', 0, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Lata Belini 18lt', 'BOTELLAS Y GALONERAS', 700, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Balde Belini x 18 lt', 'BOTELLAS Y GALONERAS', 589, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Balde Don Lalo x 20lt', 'BOTELLAS Y GALONERAS', 745, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Botella VEGA x 900 ml', 'BOTELLAS Y GALONERAS', 25200, 'UNIDADES', 'STOCK SUFICIENTE'],

            // CAJAS (Insumo vacío)
            ['Caja B-1 x 200 ml', 'CAJAS', 2437, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Caja B-1 x 500 ml', 'CAJAS', 14262, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja B-1 x 900 ml', 'CAJAS', 74125, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja B-1 x 1 lt', 'CAJAS', 11774, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Caja B-1 x 2 lt', 'CAJAS', 2220, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja B-1 x 5 lt', 'CAJAS', 2338, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Caja Don Lalo x 800ml x 12 und', 'CAJAS', 32230, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja Belini x 200 ml', 'CAJAS', 8595, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja Belini x 500 ml', 'CAJAS', 34024, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja Belini x 900 ml', 'CAJAS', 14511, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['CAJA BELINI X 1 LITRO', 'CAJAS', 26774, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja Belini x 2 lt', 'CAJAS', 1429, 'UNIDADES', 'REALIZAR PEDIDO'],
            ['Caja Belini x 5 lt', 'CAJAS', 5679, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Caja BELINI X 3 LITROS', 'CAJAS', 4404, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['CAJA TIMONEL 900ML X 12 UND', 'CAJAS', 6900, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['CAJA ACEITE VEGA 900ML X 12 UND', 'CAJAS', 13575, 'UNIDADES', 'STOCK SUFICIENTE'],

            // TAPAS Y ACCESORIOS (Agregando los faltantes del Excel)
['Tapa dosif. N° 26 blanco / Dorado', 'TAPAS Y ACCESORIOS', 61.70, 'MILL', 'REALIZAR PEDIDO'],
['Tapa Dosif. N° 26 blanco / Celeste', 'TAPAS Y ACCESORIOS', 0.00, 'MILL', 'REALIZAR PEDIDO'],
['Tapa dosif. N° 28 blanco / Dorado', 'TAPAS Y ACCESORIOS', 4.82, 'MILL', 'REALIZAR PEDIDO'],
['Asas plasticas /Dorado (2LT)', 'TAPAS Y ACCESORIOS', 4.00, 'MILL', 'REALIZAR PEDIDO'],
['Tapones Verdes', 'TAPAS Y ACCESORIOS', 0.00, 'MILL', 'REALIZAR PEDIDO'],
['Tapa Dosf. N° 28 / Celeste', 'TAPAS Y ACCESORIOS', 0.00, 'MILL', 'REALIZAR PEDIDO'],
['Tapa color Rojo 2lt', 'TAPAS Y ACCESORIOS', 3.01, 'MILL', 'STOCK SUFICIENTE'],
['Tapa Tapon 26mm (200ml)', 'TAPAS Y ACCESORIOS', 60.26, 'MILL', 'REALIZAR PEDIDO'],
['Tapa color Celeste 3lt', 'TAPAS Y ACCESORIOS', 7.60, 'MILL', 'REALIZAR PEDIDO'],
['Asas plasticas color celeste pico 45', 'TAPAS Y ACCESORIOS', 7.60, 'MILL', 'STOCK SUFICIENTE'],
['Tapa BALDE BELINI color amarillo', 'TAPAS Y ACCESORIOS', 1786.00, 'UNIDADES', 'STOCK SUFICIENTE'],
['Tapa color rojo 5lt', 'TAPAS Y ACCESORIOS', 1.44, 'MILL', 'STOCK SUFICIENTE'],
['TAAAAPA BALDE DON LALO', 'TAPAS Y ACCESORIOS', 745.00, 'UNIDADES', 'STOCK SUFICIENTE'],
          // PREFORMAS Y SERVICIOS
        ['SERVICIO SAUÑE (1LT-900ML)', 'PREFORMAS Y SERVICIOS', 58.27, 'MILL', 'REALIZAR PEDIDO'],
        ['SERVICIO SAUÑE PREFORMA 09 GR (200ML)', 'PREFORMAS Y SERVICIOS', 25.14, 'MILL', 'STOCK SUFICIENTE'],
        ['Preforma cristal 23.5 gr (PICO 26MM)', 'PREFORMAS Y SERVICIOS', 129.93, 'MILL', 'STOCK SUFICIENTE'],
        ['Preforma cristal de 26.3 GR (PICO 28MM)', 'PREFORMAS Y SERVICIOS', 0.00, 'MILL', 'REALIZAR PEDIDO'],
        ['Preforma 45 GR (2 LT)', 'PREFORMAS Y SERVICIOS', 0.00, 'MILL', 'REALIZAR PEDIDO'],
        ['Preforma cristal 15 GR (26 MLL - 500ML)', 'PREFORMAS Y SERVICIOS', 0.00, 'MILL', 'REALIZAR PEDIDO'],
        ['SERVICIO SOPLADO 500 ML PREF-15.5GR (SAUÑE)', 'PREFORMAS Y SERVICIOS', 0.00, 'MILL', 'REALIZAR PEDIDO'],
        ['Preforma cristal de 104 gr pico 45mm (3LT)', 'PREFORMAS Y SERVICIOS', 5.00, 'MILL', 'STOCK SUFICIENTE'],
        ['SERVICIO B&M DYLPLAST (PREFORMAS 23.5GR)', 'PREFORMAS Y SERVICIOS', 0.93, 'MILL', 'STOCK SUFICIENTE'],

            // ETIQUETAS
            ['Etiqueta couche 90 gr x 200 ml B-1', 'ETIQUETAS', 45.00, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 500 ml B-1', 'ETIQUETAS', 176.70, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 900 ml B-1', 'ETIQUETAS', 306.49, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 1 lt B-1', 'ETIQUETAS', 25.52, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 2 lt B-1', 'ETIQUETAS', 84.19, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta polipropileno blanco x 5 lt B-1', 'ETIQUETAS', 9.00, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90gr x 800 ml Don Lalo', 'ETIQUETAS', 50.00, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 500 ml Belini', 'ETIQUETAS', 136.74, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 900 ml Belini', 'ETIQUETAS', 52.64, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 1 lt Belini', 'ETIQUETAS', 20.36, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta polipropileno blanco x 3 lt Belini', 'ETIQUETAS', 27.64, 'MILL', 'STOCK SUFICIENTE']
        ];

        for (const art of articulos) {
            await client.query(queryInsert, art);
        }

        // 7. Sembrar Presentaciones de Producto Terminado
        const productosTerminados = [
            ['b1_200ml', 'Aceite de Soya B-1 200 ml'],
            ['b1_500ml', 'Aceite de Soya B-1 500 ml'],
            ['b1_900ml', 'Aceite de Soya B-1 900 ml'],
            ['b1_1lt', 'Aceite de Soya B-1 1 Lt'],
            ['b1_2lt', 'Aceite de Soya B-1 2 Lt'],
            ['b1_5lt', 'Aceite de Soya B-1 5 Lt (Galonera)'],
            ['donlalo_800ml', 'Aceite de Soya Don Lalo 800 ml'],
            ['donlalo_20lt', 'Aceite de Soya Don Lalo Balde 20 Lt'],
            ['belini_200ml', 'Aceite de Soya Belini 200 ml'],
            ['belini_500ml', 'Aceite de Soya Belini 500 ml'],
            ['belini_900ml', 'Aceite de Soya Belini 900 ml'],
            ['belini_1lt', 'Aceite de Soya Belini 1 Lt'],
            ['belini_2lt', 'Aceite de Soya Belini 2 Lt (Galonera)'],
            ['belini_3lt', 'Aceite de Soya Belini 3 Lt'],
            ['belini_5lt', 'Aceite de Soya Belini 5 Lt (Galonera)'],
            ['belini_lata18lt', 'Aceite de Soya Belini Lata 18 Lt'],
            ['belini_balde18lt', 'Aceite de Soya Belini Balde 18 Lt']
        ];

        for (const pt of productosTerminados) {
            await client.query(
                `INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas) VALUES ($1, $2, 0);`,
                pt
            );
        }

        await client.query('COMMIT');
        console.log('✅ Base de datos poblada y estructurada exitosamente.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al poblar base de datos:', error);
    } finally {
        client.release();
        process.exit();
    }
}

poblarInventarioReal();