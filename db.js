const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Crear automáticamente todas las tablas si no existen en Render
const inicializarBaseDeDatos = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inventario (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(255) NOT NULL,
                categoria VARCHAR(100),
                stock NUMERIC DEFAULT 0,
                unidad_medida VARCHAR(50) DEFAULT 'UNIDADES',
                estado VARCHAR(50) DEFAULT 'STOCK SUFICIENTE'
            );

            ALTER TABLE inventario ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT 'STOCK SUFICIENTE';
            ALTER TABLE inventario ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(50) DEFAULT 'UNIDADES';

            CREATE TABLE IF NOT EXISTS ingresos_vigilancia (
                id SERIAL PRIMARY KEY,
                tipo_documento VARCHAR(100),
                numero_guia VARCHAR(100),
                proveedor VARCHAR(255),
                lugar_partida VARCHAR(255),
                punto_llegada VARCHAR(255),
                producto_textual VARCHAR(255),
                cantidad NUMERIC DEFAULT 0,
                unidad_medida VARCHAR(50),
                foto_url TEXT,
                usuario_vigilancia VARCHAR(100),
                estado VARCHAR(100) DEFAULT 'PENDIENTE CONFORMIDAD',
                fecha_ingreso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS salidas_almacen (
                id SERIAL PRIMARY KEY,
                fecha_salida TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                tipo_registro VARCHAR(100),
                numero_guia VARCHAR(100),
                empresa VARCHAR(255),
                ruc VARCHAR(50),
                destino VARCHAR(255),
                chofer_licencia VARCHAR(100),
                placa VARCHAR(50),
                punto_partida VARCHAR(255),
                articulo_id INTEGER REFERENCES inventario(id),
                cantidad_salida NUMERIC DEFAULT 0,
                usuario_registro VARCHAR(100),
                estado_guia VARCHAR(100)
            );

            CREATE TABLE IF NOT EXISTS reportes_produccion (
                id SERIAL PRIMARY KEY,
                fecha_produccion DATE,
                presentacion VARCHAR(255),
                cantidad_cajas NUMERIC DEFAULT 0,
                unidad_medida VARCHAR(50) DEFAULT 'CAJAS',
                toneladas NUMERIC DEFAULT 0,
                observaciones TEXT,
                usuario_registro VARCHAR(100)
            );

            CREATE TABLE IF NOT EXISTS historial_cierres_produccion (
                id SERIAL PRIMARY KEY,
                fecha_cierre DATE,
                total_cajas NUMERIC DEFAULT 0,
                total_toneladas NUMERIC DEFAULT 0,
                usuario_cierre VARCHAR(100),
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS usuarios_sistema (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                rol VARCHAR(50) NOT NULL
            );
        `);
        console.log("Tablas e infraestructura de Base de Datos verificadas/creadas con éxito.");
    } catch (err) {
        console.error("Error al inicializar la base de datos:", err);
    }
};

inicializarBaseDeDatos();

module.exports = pool;