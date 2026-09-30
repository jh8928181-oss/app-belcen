const { Pool } = require('pg');
const dns = require('dns');
const path = require('path');

// db.js se puede require()-ear desde scripts sueltos (create-users.js, poblar.js)
// que no cargan dotenv. Se resuelve el env aqui para no depender del orden de carga.
// Respeta la precedencia: .env primero, .env.local despues con override.
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está definido en variables de entorno');
}

// Parsear connection string y forzar IPv4
const url = new URL(process.env.DATABASE_URL);
const config = {
  host: url.hostname,
  port: parseInt(url.port || '5432', 10),
  database: url.pathname.slice(1),
  user: url.username,
  password: url.password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  // Forzar resolución DNS a IPv4
  lookup: (hostname, options, callback) => {
    options.family = 4;
    dns.lookup(hostname, options, callback);
  }
};

const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('❌ Error inesperado en pool de PostgreSQL:', err);
});

module.exports = pool;