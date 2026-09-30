// Se carga el entorno aqui y no en el comando: node-pg-migrate lee el config en
// un proceso propio. Sin esto corria contra el DATABASE_URL de Render porque
// .env.local solo lo cargaban db.js e index.js.
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está definido en .env ni en .env.local');
}

module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  migrationsDir: './migrations',
  driver: 'pg',
  verbose: true,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000
};