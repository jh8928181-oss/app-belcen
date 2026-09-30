/**
 * Guarda para scripts que borran tablas.
 *
 * NODE_ENV=production no basta: tras migrar de Render a Supabase, .env.local
 * apunta a la base de producción y NODE_ENV sigue siendo "development" en local.
 * Estos scripts hacen DROP TABLE sobre lo que entonces era una base de pruebas.
 *
 * Se exige ademas:
 *   - --i-borrar-todo: confirmación explícita
 *   - ALLOW_DESTRUCTIVE_SQL=1: segunda confirmación, más difícil de escribir por error
 *   - la base debe pasar la lista de hosts permitidos
 */

const HOSTS_PERMITIDOS = ['localhost', '127.0.0.1'];

// Un sufijo de desarrollo explicito en el nombre de la base (app_belcen_dev,
// belcen_test, etc.) es la senal mas fiable de que no es produccion.
const RE_BASE_DEV = /(^|[_\-])(dev|test|testing|local|demo|sandbox)([_\-]|$)/i;

function esBaseDeDesarrollo(urlString) {
  if (!urlString) return { ok: false, motivo: 'DATABASE_URL no está definido' };
  let url;
  try {
    url = new URL(urlString);
  } catch (e) {
    return { ok: false, motivo: 'DATABASE_URL no es una URL válida' };
  }
  const host = url.hostname;
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const esLocal = HOSTS_PERMITIDOS.includes(host);
  const tieneNombreDev = RE_BASE_DEV.test(db);
  if (esLocal) return { ok: true, motivo: `host local (${host})` };
  if (tieneNombreDev) return { ok: true, motivo: `el nombre de la base indica desarrollo ("${db}")` };
  return { ok: false, motivo: `host remoto "${host}" y base "${db}" sin sufijo de desarrollo` };
}

function exigirBaseDeDesarrollo(nombreScript) {
  if (process.env.NODE_ENV === 'production') {
    console.error(`❌ ${nombreScript} no debe ejecutarse en producción (NODE_ENV=production).`);
    process.exit(1);
  }

  const url = process.env.DATABASE_URL || '';
  let host = '(sin definir)', db = '(sin definir)';
  try {
    const u = new URL(url);
    host = u.hostname;
    db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch (e) { /* se reporta abajo */ }

  console.log(`\n⚠️  ${nombreScript} va a BORRAR TODAS las tablas de:`);
  console.log(`     host: ${host}`);
  console.log(`     base: ${db}\n`);

  const veredicto = esBaseDeDesarrollo(url);
  if (!veredicto.ok) {
    console.error(`❌ ABORTADO: ${veredicto.motivo}.`);
    console.error('   Este script destruiría datos reales.');
    console.error('   Si de verdad necesitas vaciarla, apúntala a una base de desarrollo');
    console.error('   (o exporta ALLOW_DESTRUCTIVE_SQL=1 asumiendo el riesgo).');
    process.exit(1);
  }
  console.log(`   ✓ Seems una base de desarrollo: ${veredicto.motivo}`);

  if (!process.argv.includes('--i-borrar-todo')) {
    console.error('\n❌ ABORTADO: falta la confirmación explícita --i-borrar-todo');
    process.exit(1);
  }
  if (process.env.ALLOW_DESTRUCTIVE_SQL !== '1') {
    console.error('\n❌ ABORTADO: falta ALLOW_DESTRUCTIVE_SQL=1');
    process.exit(1);
  }
  console.log('');
}

module.exports = { exigirBaseDeDesarrollo, esBaseDeDesarrollo };
