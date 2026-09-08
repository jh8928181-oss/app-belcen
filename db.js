const { Pool } = require('pg');

// Configuración de credenciales de PostgreSQL
const pool = new Pool({
  user: 'postgres',          // Tu usuario de PostgreSQL
  host: 'localhost',         // O la IP del NAS en red local
  database: 'belcen_db',     // Nombre de la base de datos
  password: '123456',    // Tu contraseña de PostgreSQL
  port: 5432,
});

pool.on('connect', () => {
  console.log('Conectado exitosamente a la Base de Datos PostgreSQL');
});

module.exports = pool;