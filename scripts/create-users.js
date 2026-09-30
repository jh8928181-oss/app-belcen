require('dotenv').config();

// Se marca como desarrollo si el entorno no dice lo contrario.
// El ||= respeta un NODE_ENV=production ya definido, para que la guarda de abajo siga bloqueando.
process.env.NODE_ENV ||= 'development';

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
    { usuario: 'ing_blas', rol: 'supervisor' },
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
    // El rol puede sobreescribirse por entorno (SEED_ROL_<USUARIO>), para no tener
    // que editar el codigo cuando alguien cambia de puesto.
    const rol = process.env[`SEED_ROL_${u.usuario.toUpperCase()}`] || u.rol;
    users.push({ usuario: u.usuario, password: pwd, rol });
  }
  return users;
}

// Por defecto el script SOLO inserta los que faltan: un usuario ya existente
// conserva su contraseña y su rol, aunque las variables SEED_PWD_* hayan cambiado.
// Con --reset-passwordes se sobrescriben contraseña y rol de los usuarios semilla.
const RESETEAR = process.argv.includes('--reset-passwordes');

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

      if (RESETEAR) {
        const r = await client.query(
          `INSERT INTO usuarios_sistema (usuario, password, rol) VALUES ($1, $2, $3)
           ON CONFLICT (usuario) DO UPDATE SET password = EXCLUDED.password, rol = EXCLUDED.rol
           RETURNING (xmax = 0) AS insertado;`,
          [usuario, `${hash}:${salt}`, rol]
        );
        console.log(`${r.rows[0].insertado ? '✅ Creado' : '🔄 Actualizado'}: ${usuario} (${rol})`);
      } else {
        const r = await client.query(
          `INSERT INTO usuarios_sistema (usuario, password, rol) VALUES ($1, $2, $3)
           ON CONFLICT (usuario) DO NOTHING
           RETURNING id;`,
          [usuario, `${hash}:${salt}`, rol]
        );
        console.log(
          r.rows.length
            ? `✅ Creado: ${usuario} (${rol})`
            : `➖ Sin cambios: ${usuario} ya existía (use --reset-passwordes para actualizar)`
        );
      }
    }

    await client.query('COMMIT');
    console.log('✅ Usuarios procesados exitosamente.');
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