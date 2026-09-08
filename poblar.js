const pool = require('./db');

async function poblarInventarioReal() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DROP TABLE IF EXISTS articulos CASCADE;');
        await client.query('DROP TABLE IF EXISTS usuarios_sistema CASCADE;');

        // 1. Crear tabla de artículos
        await client.query(`
            CREATE TABLE articulos (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(150) NOT NULL,
                categoria VARCHAR(50) NOT NULL,
                stock NUMERIC(10,2) NOT NULL DEFAULT 0,
                unidad_medida VARCHAR(20) NOT NULL,
                estado_stock VARCHAR(30)
            );
        `);

        // 2. Crear tabla de usuarios del sistema
        await client.query(`
            CREATE TABLE usuarios_sistema (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                rol VARCHAR(30) NOT NULL
            );
        `);

        // 3. Insertar usuarios iniciales con roles y contraseñas
        await client.query(`
    INSERT INTO usuarios_sistema (usuario, password, rol) VALUES 
    ('vigilancia1', 'belcen2026*', 'vigilancia'),
    ('vigilancia2', 'belcen2026*', 'vigilancia'),
    ('almacen1', 'almacenpass1', 'almacen'),
    ('almacen2', 'almacenpass2', 'almacen'),
    ('soplado_user', 'soplado123', 'soplado'),
    ('envasado_user', 'envasado123', 'envasado'),
    ('auditor_user', 'auditor123', 'auditoria')
    ON CONFLICT (usuario) DO NOTHING;
        `);

        const queryInsert = `
            INSERT INTO articulos (nombre, categoria, stock, unidad_medida, estado_stock) 
            VALUES ($1, $2, $3, $4, $5);
        `;

        const articulos = [
            // BOTELLAS / GALONERAS / BALDES / LATAS
            ['Botella de 200 ml - B-1', 'Botellas', 25274, 'UND', 'STOCK SUFICIENTE'],
            ['Botella de 500 ml - B-1', 'Botellas', 10906, 'UND', 'REALIZAR PEDIDO'],
            ['Botella de 900 ml - B-1', 'Botellas', 6126, 'UND', 'REALIZAR PEDIDO'],
            ['Botella de 1 Lt - B-1', 'Botellas', 30977, 'UND', 'REALIZAR PEDIDO'],
            ['Botella de 2 Lt - B-1', 'Botellas', 665, 'UND', 'REALIZAR PEDIDO'],
            ['Galonera B-1 x 5 lt', 'Botellas', 1438, 'UND', 'STOCK SUFICIENTE'],
            ['Botella de 800ml - Don Lalo', 'Botellas', 0, 'UND', 'REALIZAR PEDIDO'],
            ['Botella Belini x 3 lt', 'Botellas', 1352, 'UND', 'REALIZAR PEDIDO'],
            ['Botella Belini x 200 ml', 'Botellas', 0, 'UND', 'REALIZAR PEDIDO'],
            ['Botella Belini x 500 ml', 'Botellas', 19374, 'UND', 'STOCK SUFICIENTE'],
            ['Botella Belini x 900 ml', 'Botellas', 44137, 'UND', 'STOCK SUFICIENTE'],
            ['Botella Belini x 1 lt', 'Botellas', 5368, 'UND', 'REALIZAR PEDIDO'],
            ['Galonera Belini x 2 lt', 'Botellas', 0, 'UND', 'REALIZAR PEDIDO'],
            ['Galonera Belini x 5 lt', 'Botellas', 0, 'UND', 'REALIZAR PEDIDO'],
            ['Lata Belini 18lt', 'Botellas', 700, 'UND', 'STOCK SUFICIENTE'],
            ['Balde Belini x 18 lt', 'Botellas', 589, 'UND', 'STOCK SUFICIENTE'],
            ['Balde Don Lalo x 20lt', 'Botellas', 745, 'UND', 'STOCK SUFICIENTE'],
            ['Botella VEGA x 900 ml', 'Botellas', 25200, 'UND', 'STOCK SUFICIENTE'],

            // CAJAS
            ['Caja B-1 x 200 ml', 'Cajas', 2437, 'UND', 'REALIZAR PEDIDO'],
            ['Caja B-1 x 500 ml', 'Cajas', 14262, 'UND', 'STOCK SUFICIENTE'],
            ['Caja B-1 x 900 ml', 'Cajas', 74125, 'UND', 'STOCK SUFICIENTE'],
            ['Caja B-1 x 1 lt', 'Cajas', 11774, 'UND', 'REALIZAR PEDIDO'],
            ['Caja B-1 x 2 lt', 'Cajas', 2220, 'UND', 'STOCK SUFICIENTE'],
            ['Caja B-1 x 5 lt', 'Cajas', 2338, 'UND', 'REALIZAR PEDIDO'],
            ['Caja Don Lalo x 800ml x 12 und', 'Cajas', 32230, 'UND', 'STOCK SUFICIENTE'],
            ['Caja Belini x 200 ml', 'Cajas', 8595, 'UND', 'STOCK SUFICIENTE'],
            ['Caja Belini x 500 ml', 'Cajas', 34024, 'UND', 'STOCK SUFICIENTE'],
            ['Caja Belini x 900 ml', 'Cajas', 14511, 'UND', 'STOCK SUFICIENTE'],
            ['Caja BELINI X 1 LITRO', 'Cajas', 26774, 'UND', 'STOCK SUFICIENTE'],
            ['Caja Belini x 2 lt', 'Cajas', 1429, 'UND', 'REALIZAR PEDIDO'],
            ['Caja Belini x 5 lt', 'Cajas', 5679, 'UND', 'STOCK SUFICIENTE'],
            ['Caja BELINI X 3 LITROS', 'Cajas', 4404, 'UND', 'STOCK SUFICIENTE'],
            ['CAJA TIMONEL 900ML X 12 UND', 'Cajas', 6900, 'UND', 'STOCK SUFICIENTE'],
            ['CAJA ACEITE VEGA 900ML X 12 UND', 'Cajas', 13575, 'UND', 'STOCK SUFICIENTE'],

            // TAPAS Y ACCESORIOS
            ['Tapa dosif. N° 28 blanco / Dorado', 'Tapas', 4.82, 'MILL', 'REALIZAR PEDIDO'],
            ['Tapa color Rojo 2lt', 'Tapas', 3.01, 'MILL', 'STOCK SUFICIENTE'],
            ['Tapa dorada 2lt', 'Tapas', 0.00, 'MILL', 'REALIZAR PEDIDO'],
            ['Tapa Tapon 26mm (200ml)', 'Tapas', 60.26, 'MILL', 'REALIZAR PEDIDO'],
            ['Tapa color Celeste 3lt', 'Tapas', 7.60, 'MILL', 'REALIZAR PEDIDO'],
            ['Asas plasticas color celeste pico 45', 'Tapas', 7.60, 'MILL', 'STOCK SUFICIENTE'],
            ['Tapa BALDE BELINI color amarillo', 'Tapas', 1786.00, 'UND', 'STOCK SUFICIENTE'],
            ['Tapa dorada 5lt', 'Tapas', 1.44, 'MILL', 'STOCK SUFICIENTE'],
            ['TAAAAPA BALDE DON LALO', 'Tapas', 745.00, 'UND', 'STOCK SUFICIENTE'],
            ['Tapa Dosif. N° 26 blanco / Dorado', 'Tapas', 61.70, 'MILL', 'REALIZAR PEDIDO'],

            // PREFORMAS Y SERVICIOS
            ['SERVICIO SAUÑE (1LT-900ML)', 'Preformas', 13.27, 'MILL', 'REALIZAR PEDIDO'],
            ['SERVICIO SAUÑE PREFORMA 09 GR (200ML)', 'Preformas', 41.24, 'MILL', 'STOCK SUFICIENTE'],
            ['Preforma cristal 23.5 gr (PICO 26MM)', 'Preformas', 25.83, 'MILL', 'STOCK SUFICIENTE'],
            ['SERVICIO SOPLADO 500 ML PREF-15.5GR (SAUÑE)', 'Preformas', 12.72, 'MILL', 'STOCK SUFICIENTE'],
            ['Preforma cristal de 104 gr pico 45mm (3LT)', 'Preformas', 5.00, 'MILL', 'STOCK SUFICIENTE'],
            ['SERVICIO B&M DYLPLAST (PREFORMAS 23.5GR)', 'Preformas', 0.93, 'MILL', 'STOCK SUFICIENTE'],

            // ETIQUETAS
            ['Etiqueta couche 90 gr x 200 ml B-1', 'Etiquetas', 45.00, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 500 ml B-1', 'Etiquetas', 176.70, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 900 ml B-1', 'Etiquetas', 306.49, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 1 lt B-1', 'Etiquetas', 25.52, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 2 lt B-1', 'Etiquetas', 84.19, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta polipropileno blanco x 5 lt B-1', 'Etiquetas', 9.00, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90gr x 800 ml Don Lalo', 'Etiquetas', 50.00, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 500 ml Belini', 'Etiquetas', 136.74, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 900 ml Belini', 'Etiquetas', 52.64, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta couche 90 gr x 1 lt Belini', 'Etiquetas', 20.36, 'MILL', 'REALIZAR PEDIDO'],
            ['Etiqueta polipropileno blanco x 3 lt Belini', 'Etiquetas', 27.64, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 900ml TIMONEL', 'Etiquetas', 70.00, 'MILL', 'STOCK SUFICIENTE'],
            ['Etiqueta couche 90 gr x 900 ml VEGA', 'Etiquetas', 129.80, 'MILL', 'STOCK SUFICIENTE']
        ];

        for (const art of articulos) {
            await client.query(queryInsert, art);
        }

        await client.query('COMMIT');
        console.log('✅ Base de datos poblada exitosamente con inventario y usuarios.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al poblar base de datos:', error);
    } finally {
        client.release();
        process.exit();
    }
}

poblarInventarioReal();