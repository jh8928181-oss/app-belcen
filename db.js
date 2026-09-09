const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const inicializarBaseDeDatos = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inventario (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(150) UNIQUE NOT NULL,
                categoria VARCHAR(100),
                stock NUMERIC(10,2) DEFAULT 0,
                unidad_medida VARCHAR(50) DEFAULT 'UNIDADES',
                estado VARCHAR(50) DEFAULT 'STOCK SUFICIENTE'
            );

            ALTER TABLE inventario ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT 'STOCK SUFICIENTE';
            ALTER TABLE inventario ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(50) DEFAULT 'UNIDADES';

            CREATE TABLE IF NOT EXISTS ingresos_vigilancia (
                id SERIAL PRIMARY KEY,
                tipo_documento VARCHAR(50),
                numero_guia VARCHAR(100),
                proveedor VARCHAR(100),
                lugar_partida VARCHAR(100),
                punto_llegada VARCHAR(100),
                producto_textual VARCHAR(150),
                cantidad NUMERIC(10,2),
                unidad_medida VARCHAR(20),
                foto_url VARCHAR(255),
                usuario_vigilancia VARCHAR(50),
                estado VARCHAR(50) DEFAULT 'PENDIENTE CONFORMIDAD',
                fecha_ingreso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS salidas_almacen (
                id SERIAL PRIMARY KEY,
                fecha_salida TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                tipo_registro VARCHAR(30),
                numero_guia VARCHAR(100),
                empresa VARCHAR(150),
                ruc VARCHAR(20),
                destino VARCHAR(150),
                chofer_licencia VARCHAR(150),
                placa VARCHAR(50),
                punto_partida VARCHAR(150),
                articulo_id INT REFERENCES inventario(id),
                cantidad_salida NUMERIC(10,2),
                usuario_registro VARCHAR(50),
                estado_guia VARCHAR(50) DEFAULT 'REGULARIZADO'
            );

            CREATE TABLE IF NOT EXISTS reportes_produccion (
                id SERIAL PRIMARY KEY,
                fecha_produccion DATE DEFAULT CURRENT_DATE,
                presentacion VARCHAR(150),
                cantidad_cajas INT,
                unidad_medida VARCHAR(20) DEFAULT 'CAJAS',
                toneladas NUMERIC(10,2),
                observaciones TEXT,
                usuario_registro VARCHAR(50),
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS historial_cierres_produccion (
                id SERIAL PRIMARY KEY,
                fecha_cierre DATE NOT NULL,
                total_cajas INT DEFAULT 0,
                total_toneladas NUMERIC(10,2) DEFAULT 0,
                detalle_lotes TEXT,
                usuario_cierre VARCHAR(50),
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS usuarios_sistema (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(50) NOT NULL,
                rol VARCHAR(30) NOT NULL
            );
        `);

        console.log("Infraestructura de DB en Render sincronizada correctamente.");
    } catch (err) {
        console.error("Error al inicializar la base de datos:", err);
    }
};

inicializarBaseDeDatos();

module.exports = pool;