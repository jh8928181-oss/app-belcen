require('dotenv').config();
const pool = require('../db');
const crypto = require('crypto');
const { promisify } = require('util');
const scryptP = promisify(crypto.scrypt);

if (process.env.NODE_ENV === 'production') {
  console.error('❌ ERROR: Este script NO debe ejecutarse en producción. Borraría todos los datos.');
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

async function seedDev() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Limpiar tablas existentes (SOLO DESARROLLO)
    await client.query('DROP TABLE IF EXISTS inventario CASCADE;');
    await client.query('DROP TABLE IF EXISTS producto_terminado CASCADE;');
    await client.query('DROP TABLE IF EXISTS usuarios_sistema CASCADE;');
    await client.query('DROP TABLE IF EXISTS ingresos_vigilancia CASCADE;');
    await client.query('DROP TABLE IF EXISTS registro_ingresos_almacen CASCADE;');
    await client.query('DROP TABLE IF EXISTS salidas_almacen CASCADE;');
    await client.query('DROP TABLE IF EXISTS reportes_produccion CASCADE;');
    await client.query('DROP TABLE IF EXISTS historial_cierres_produccion CASCADE;');
    await client.query('DROP TABLE IF EXISTS reportes_refinado CASCADE;');
    await client.query('DROP TABLE IF EXISTS stock_insumos_refinado CASCADE;');
    await client.query('DROP TABLE IF EXISTS reportes_soplado CASCADE;');
    await client.query('DROP TABLE IF EXISTS estado_lineas CASCADE;');
    await client.query('DROP TABLE IF EXISTS historial_inventario CASCADE;');
    await client.query('DROP TABLE IF EXISTS proveedores CASCADE;');
    await client.query('DROP TABLE IF EXISTS ordenes_compras_servicios CASCADE;');
    await client.query('DROP TABLE IF EXISTS ordenes_items CASCADE;');
    await client.query('DROP TABLE IF EXISTS stock_proveedores CASCADE;');
    await client.query('DROP TABLE IF EXISTS stock_proveedores_historial CASCADE;');

    // 2. Ejecutar migraciones (recrear esquema limpio)
    console.log('🔄 Ejecutando migraciones...');
    const { default: migrate } = await import('node-pg-migrate');
    await migrate({
      databaseUrl: process.env.DATABASE_URL,
      migrationsDir: './migrations',
      driver: 'pg',
      direction: 'up',
      verbose: true
    });

    // 3. Sembrar usuarios desde variables de entorno
    const usuariosSeed = getSeedUsers();
    for (const { usuario, password, rol } of usuariosSeed) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await hashPassword(password, salt);
      await client.query(
        `INSERT INTO usuarios_sistema (usuario, password, rol) VALUES ($1, $2, $3) ON CONFLICT (usuario) DO NOTHING;`,
        [usuario, `${hash}:${salt}`, rol]
      );
      console.log(`✅ Usuario creado: ${usuario} (${rol})`);
    }

    await client.query('COMMIT');
    console.log('✅ Base de datos de desarrollo poblada exitosamente.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error al poblar base de datos:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    process.exit();
  }
}

seedDev();