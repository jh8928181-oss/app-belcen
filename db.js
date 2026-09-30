const { Pool } = require('pg');
const dns = require('dns');

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