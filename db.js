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

            CREATE TABLE IF NOT EXISTS producto_terminado (
                id SERIAL PRIMARY KEY,
                producto_key VARCHAR(100) UNIQUE NOT NULL,
                nombre_producto VARCHAR(150) NOT NULL,
                stock_cajas INT DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS ingresos_vigilancia (
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

            -- Sincronización automática de columnas para bases de datos existentes en Render
            ALTER TABLE ingresos_vigilancia ADD COLUMN IF NOT EXISTS chofer VARCHAR(150);
            ALTER TABLE ingresos_vigilancia ADD COLUMN IF NOT EXISTS dni_chofer VARCHAR(50);
            ALTER TABLE ingresos_vigilancia ADD COLUMN IF NOT EXISTS placa VARCHAR(50);
            ALTER TABLE ingresos_vigilancia ADD COLUMN IF NOT EXISTS observaciones TEXT;
            ALTER TABLE ingresos_vigilancia ADD COLUMN IF NOT EXISTS items_json TEXT;

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
                producto_key VARCHAR(100),
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