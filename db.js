const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000
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
                stock_cajas INT DEFAULT 0,
                stock_minimo INT DEFAULT 0
            );

            ALTER TABLE producto_terminado ADD COLUMN IF NOT EXISTS stock_minimo INT DEFAULT 0;

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

            ALTER TABLE salidas_almacen ADD COLUMN IF NOT EXISTS guia_url TEXT;
            ALTER TABLE salidas_almacen ADD COLUMN IF NOT EXISTS despacho_id VARCHAR(50);

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

            ALTER TABLE reportes_produccion ADD COLUMN IF NOT EXISTS desglose_insumos TEXT;

            CREATE TABLE IF NOT EXISTS registro_ingresos_almacen (
                id SERIAL PRIMARY KEY,
                fecha_registro DATE,
                numero_guia VARCHAR(100),
                proveedor VARCHAR(150),
                producto_nombre VARCHAR(150),
                cantidad NUMERIC(10,2),
                estado VARCHAR(50),
                articulo_id INT REFERENCES inventario(id)
            );

            ALTER TABLE registro_ingresos_almacen ADD COLUMN IF NOT EXISTS categoria VARCHAR(100);
            ALTER TABLE registro_ingresos_almacen ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(20);

            CREATE TABLE IF NOT EXISTS historial_cierres_produccion (
                id SERIAL PRIMARY KEY,
                fecha_cierre DATE NOT NULL,
                total_cajas NUMERIC(10,2) DEFAULT 0,
                total_toneladas NUMERIC(10,2) DEFAULT 0,
                usuario_cierre VARCHAR(50),
                detalle_json TEXT,
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS usuarios_sistema (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(300) NOT NULL,
                rol VARCHAR(30) NOT NULL
            );

            ALTER TABLE usuarios_sistema ALTER COLUMN password TYPE VARCHAR(300);

            CREATE TABLE IF NOT EXISTS reportes_refinado (
                id SERIAL PRIMARY KEY,
                fecha_reporte DATE NOT NULL,
                turno VARCHAR(10) NOT NULL DEFAULT 'DIA',
                insumos_json TEXT NOT NULL,
                aceite_json TEXT NOT NULL,
                totales_json TEXT,
                observaciones TEXT,
                usuario_registro VARCHAR(50),
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(fecha_reporte, turno)
            );

            ALTER TABLE reportes_refinado ADD COLUMN IF NOT EXISTS turno VARCHAR(10) NOT NULL DEFAULT 'DIA';
            ALTER TABLE reportes_refinado DROP CONSTRAINT IF EXISTS reportes_refinado_fecha_reporte_key;
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reportes_refinado_fecha_turno') THEN
                    ALTER TABLE reportes_refinado ADD CONSTRAINT reportes_refinado_fecha_turno UNIQUE (fecha_reporte, turno);
                END IF;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;

            -- Usuarios de turno de Refinado (idempotente)
            INSERT INTO usuarios_sistema (usuario, password, rol) VALUES
                ('usuario1', 'a49a94603f9a105326f880170b9342a6fd3ed71157b4dd16da4fbd46648c7f45721b25e49f83a1038bb333e4af25a59be35725e5e8b3b19e79a87fdb648299f3:8222cb2d385b1216e4e53a27ab34e4eb', 'refinado'),
                ('usuario2', '92aeb3d6f95d8c376cbe75acb1c1a30b93a08e55461c834125d0ffa5b5075b047f0a5352e5d641625aa9f403372bc0d35e78a7d45929deba8242747da382752e:cd9c611efd774c52e9e7bfa303c8a277', 'refinado')
            ON CONFLICT (usuario) DO NOTHING;

            -- Usuario administrador inicial (idempotente); cambia su clave desde admin.html
            INSERT INTO usuarios_sistema (usuario, password, rol) VALUES
                ('admin1', '4068cf56e3974d0a6c6b6e4537dc5b538b74f3b0a9c99bea308cece234451af9f370ac108adf177a7823c9f92c4c541446fd8244cf933879d9de017ad1667752:49e5f7703daa241b99dfda3df52fe916', 'admin')
            ON CONFLICT (usuario) DO NOTHING;
        `);

        console.log("Infraestructura de DB en Render sincronizada correctamente.");
    } catch (err) {
        console.error("Error al inicializar la base de datos:", err);
    }
};

inicializarBaseDeDatos();

module.exports = pool;