const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Auto-crear / actualizar estructura de columnas
pool.query(`
    ALTER TABLE inventario ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT 'STOCK SUFICIENTE';
    ALTER TABLE inventario ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(50) DEFAULT 'UNIDADES';
`).then(() => {
    console.log("Estructura de tabla 'inventario' verificada en PostgreSQL.");
}).catch(err => {
    console.error("Error al verificar columnas en DB:", err);
});

module.exports = pool;