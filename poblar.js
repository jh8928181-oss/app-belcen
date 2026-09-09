const pool = require('./db');

async function poblarInventarioReal() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Limpiar tablas existentes
        await client.query('DROP TABLE IF EXISTS inventario CASCADE;');
        await client.query('DROP TABLE IF EXISTS usuarios_sistema CASCADE;');

        // 2. Crear tabla inventario (la que lee la API /api/inventario)
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

        // 3. Crear usuarios
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

        // 4. Insertar datos oficiales
        const queryInsert = `
            INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) 
            VALUES ($1, $2, $3, $4, $5);
        `;

        const articulos = [
            // ENVASES
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

            // CAJAS
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

            // TAPAS Y ACCESORIOS
            ['Tapa dosif. N° 26 blanco / Dorado', 'TAPAS Y ACCESORIOS', 61.70, 'MILL', 'REALIZAR PEDIDO'],
            ['Tapa color Rojo 2lt', 'TAPAS Y ACCESORIOS', 3.01, 'MILL', 'STOCK SUFICIENTE'],
            ['Tapa Tapon 26mm (200ml)', 'TAPAS Y ACCESORIOS', 60.26, 'MILL', 'REALIZAR PEDIDO'],
            ['Tapa color Celeste 3lt', 'TAPAS Y ACCESORIOS', 7.60, 'MILL', 'REALIZAR PEDIDO'],
            ['Asas plasticas color celeste pico 45', 'TAPAS Y ACCESORIOS', 7.60, 'MILL', 'STOCK SUFICIENTE'],
            ['Tapa BALDE BELINI color amarillo', 'TAPAS Y ACCESORIOS', 1786.00, 'UNIDADES', 'STOCK SUFICIENTE'],
            ['Tapa color rojo 5lt', 'TAPAS Y ACCESORIOS', 1.44, 'MILL', 'STOCK SUFICIENTE'],
            ['TAAAAPA BALDE DON LALO', 'TAPAS Y ACCESORIOS', 745.00, 'UNIDADES', 'STOCK SUFICIENTE'],

            // PREFORMAS Y SERVICIOS
            ['SERVICIO SAUÑE (1LT-900ML)', 'PREFORMAS Y SERVICIOS', 13.27, 'MILL', 'REALIZAR PEDIDO'],
            ['SERVICIO SAUÑE PREFORMA 09 GR (200ML)', 'PREFORMAS Y SERVICIOS', 41.24, 'MILL', 'STOCK SUFICIENTE'],
            ['Preforma cristal 23.5 gr (PICO 26MM)', 'PREFORMAS Y SERVICIOS', 25.83, 'MILL', 'STOCK SUFICIENTE'],
            ['SERVICIO SOPLADO 500 ML PREF-15.5GR (SAUÑE)', 'PREFORMAS Y SERVICIOS', 12.72, 'MILL', 'STOCK SUFICIENTE'],
            ['Preforma cristal de 104 gr pico 45mm (3LT)', 'PREFORMAS Y SERVICIOS', 5.00, 'MILL', 'STOCK SUFICIENTE'],

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

        await client.query('COMMIT');
        console.log('✅ Base de datos "inventario" poblada exitosamente.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al poblar base de datos:', error);
    } finally {
        client.release();
        process.exit();
    }
}

poblarInventarioReal();