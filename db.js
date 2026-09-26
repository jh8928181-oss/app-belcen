const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está definido en variables de entorno');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en pool de PostgreSQL:', err);
});

module.exports = pool;