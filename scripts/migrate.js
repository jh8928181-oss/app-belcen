/**
 * Corredor de migraciones con la MISMA configuracion de conexion que db.js.
 *
 * El CLI de node-pg-migrate arma su propio pg.Client desde la URL y no aplica
 * el forzado de IPv4 que hace db.js (lookup con family 4). Sin eso, resolver el
 * pooler de Supabase cae a IPv6 y la conexion muere con ECONNRESET.
 *
 * Ademas carga .env y .env.local aqui, porque el CLI corre en otro proceso.
 *
 *   node scripts/migrate.js up
 *   node scripts/migrate.js down [n]
 *   node scripts/migrate.js redo
 *   node scripts/migrate.js status
 */

const path = require('path');
const dns = require('dns');
const { Client } = require('pg');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, '.env.local'), override: true });

const DIRECCIONES = { up: 'up', down: 'down', status: 'status', redo: 'redo' };

async function main() {
  const arg = process.argv[2] || 'up';
  const direccion = DIRECCIONES[arg];
  if (!direccion) {
    console.error(`Dirección no válida: ${arg}. Usa up | down | redo | status`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está definido en .env ni en .env.local');
  }

  const url = new URL(process.env.DATABASE_URL);
  const destino = `${url.hostname}/${url.pathname.slice(1)}`;
  console.log(`\nBase destino: ${destino}\n`);

  // node-pg-migrate usa una transaccion para aplicar cada migracion: el pooler en
  // modo transaccion (6543) no la soporta. Se usa la sesion directa (5432).
  const puertoSesion = 5432;
  if (url.port && url.port !== '5432') {
    console.log(`La URL apunta al puerto ${url.port} (pooler). Se usara ${puertoSesion} para las migraciones.`);
  }

  const client = new Client({
    host: url.hostname,
    port: puertoSesion,
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    lookup: (hostname, options, callback) => {
      options.family = 4;
      dns.lookup(hostname, options, callback);
    }
  });

  await client.connect();

  const { runner } = require('node-pg-migrate');
  const opciones = {
    dbClient: client,
    dir: path.join(ROOT, 'migrations'),
    direction: direccion,
    // Explicitos porque con dbClient el corredor no los deduce igual que el CLI:
    // sin esto intenta aplicar la migracion inicial sobre un esquema ya creado.
    migrationsTable: 'pgmigrations',
    schema: 'public',
    checkOrder: true,
    verbose: true,
    log: (...args) => console.log(...args)
  };

  if (arg === 'status') {
    // El corredor de node-pg-migrate no tiene dirección "status": el estado se
    // Arma comparando los archivos del directorio contra lo registrado.
    const aplicada = await client.query(
      'SELECT name, run_on FROM public.pgmigrations ORDER BY id'
    );
    const fs = require('fs');
    // node-pg-migrate registra el nombre SIN extensión: se compara sobre esa base.
    const enDisco = fs.readdirSync(opciones.dir)
      .filter(f => /\.(mjs|cjs|js)$/.test(f))
      .sort();
    const sinExt = f => f.replace(/\.(mjs|cjs|js)$/, '');
    const registradas = new Set(aplicada.rows.map(r => r.name));
    const fechaDe = new Map(aplicada.rows.map(r => [r.name, r.run_on]));

    console.log('Aplicadas en la base:');
    if (!aplicada.rows.length) console.log('  (ninguna)');
    aplicada.rows.forEach(r => console.log(`  ✓ ${r.name}  ${r.run_on ? r.run_on.toISOString() : ''}`));

    const pendientes = enDisco.map(sinExt).filter(n => !registradas.has(n));
    console.log('\nPendientes:');
    if (!pendientes.length) console.log('  (ninguna)');
    pendientes.forEach(f => console.log(`  • ${f}`));

    const archivos = new Set(enDisco.map(sinExt));
    const huerfanas = aplicada.rows.filter(r => !archivos.has(r.name));
    if (huerfanas.length) {
      console.log('\nRegistradas pero sin archivo:');
      huerfanas.forEach(r => console.log(`  ? ${r.name}  ${fechaDe.get(r.name) ? fechaDe.get(r.name).toISOString() : ''}`));
    }
    await client.end();
    return;
  }

  if (arg === 'down') {
    opciones.count = process.argv[3] ? parseInt(process.argv[3], 10) : 1;
  }

  // node-pg-migrate no tiene dirección "redo": se deshace la última y se
  // reaplica, en la MISMA conexión para no perder la sesión del pooler.
  if (arg === 'redo') {
    console.log('Revirtiendo la última migración y reaplicándola...\n');
    const revertidas = await runner({ ...opciones, direction: 'down', count: 1, verbose: true });
    if (!revertidas.length) {
      console.log('No hay migraciones aplicadas para revertir.');
      await client.end();
      return;
    }
    revertidas.forEach(m => console.log('  ↩ ', m.name));
    const aplicadas = await runner({ ...opciones, direction: 'up', verbose: true });
    await client.end();
    console.log(`\nAplicadas: ${aplicadas.length}`);
    aplicadas.forEach(m => console.log('  ✓', m.name));
    return;
  }

  const aplicadas = await runner(opciones);
  await client.end();

  console.log(`\nAplicadas: ${aplicadas.length}`);
  aplicadas.forEach(m => console.log('  ✓', m.name));
}

main().catch(err => {
  console.error('\nError al migrar:', err.message);
  process.exit(1);
});
