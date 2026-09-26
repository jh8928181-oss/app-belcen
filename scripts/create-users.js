require('dotenv').config();
const pool = require('../db');
const crypto = require('crypto');
const { promisify } = require('util');
const scryptP = promisify(crypto.scrypt);

if (process.env.NODE_ENV === 'production') {
  console.error('❌ ERROR: Este script NO debe ejecutarse en producción.');
  process.exit(1);
}

async function hashPassword(password, salt) {
  const buf = await scryptP(password, salt, 64);
  return buf.toString('hex');
}

function getSeedUsers() {
  const users = [];
  const defaultUsers = [
    { usuario: 'vigilancia1', rol: 'vigilancia' },
    { usuario: 'almacen1', rol: 'almacen' },
    { usuario: 'soplado_user', rol: 'soplado' },
    { usuario: 'envasado_user', rol: 'envasado' },
    { usuario: 'auditor_user', rol: 'auditoria' },
    { usuario: 'ing_blas', rol: 'produccion' },
    { usuario: 'pariona', rol: 'supervisor' },
    { usuario: 'acceso_1', rol: 'invitado' },
    { usuario: 'acceso_2', rol: 'invitado' },
    { usuario: 'admin1', rol: 'admin' }
  ];

  for (const u of defaultUsers) {
    const pwd = process.env[`SEED_PWD_${u.usuario.toUpperCase()}`];
    if (!pwd) {
      console.warn(`⚠️  SEED_PWD_${u.usuario.toUpperCase()} no definido en .env, saltando usuario ${u.usuario}`);
      continue;
    }
    users.push({ usuario: u.usuario, password: pwd, rol: u.rol });
  }
  return users;
}

async function createUsersOnly() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const usuariosSeed = getSeedUsers();
    if (usuariosSeed.length === 0) {
      console.warn('⚠️  No hay usuarios semilla configurados (faltan SEED_PWD_* en .env)');
      await client.query('COMMIT');
      return;
    }

    for (const { usuario, password, rol } of usuariosSeed) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await hashPassword(password, salt);
      await client.query(
        `INSERT INTO usuarios_sistema (usuario, password, rol) VALUES ($1, $2, $3) ON CONFLICT (usuario) DO NOTHING;`,
        [usuario, `${hash}:${salt}`, rol]
      );
      console.log(`✅ Usuario creado/actualizado: ${usuario} (${rol})`);
    }

    await client.query('COMMIT');
    console.log('✅ Usuarios creados exitosamente.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    process.exit();
  }
}

createUsersOnly();