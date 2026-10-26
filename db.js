const { Pool } = require('pg');
const dns = require('dns');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está definido en variables de entorno');
}

const url = new URL(process.env.DATABASE_URL);
const config = {
  host: url.hostname,
  port: parseInt(url.port || '5432', 10),
  database: url.pathname.slice(1),
  user: url.username,
  password: url.password,
  ssl: { rejectUnauthorized: false },
  // Si Supabase no responde, la conexión falla en 10 s en vez de quedarse
  // colgada para siempre esperando el handshake.
  connectionTimeoutMillis: 10000,
  // Un socket ocioso puede morir por un corte de red sin avisar: se descarta
  // rápido para que la siguiente consulta abra una conexión nueva.
  idleTimeoutMillis: 10000,
  // TCP keepalive: le avisa al SO cuando el otro extremo dejó de responder,
  // de modo que un corte breve se detecta y no se manda una consulta a un
  // socket muerto (eso es lo que produce ECONNRESET tras una reconexión).
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Red de seguridad: una consulta que no responde no deja un slot del pool
  // ocupado para siempre (10 consultas colgadas dejarían el ERP entero sin
  // atender aunque el proceso siga "vivo"). Es un timeout SOLO del lado del
  // cliente: no se envía SQL al servidor, así que funciona igual contra el
  // pooler de Supabase (6543) que contra la conexión directa (5432). No se
  // usa statement_timeout porque viaja como parámetro del startup packet y
  // el pooler de Supabase (pgbouncer) puede rechazarlo y cortar todo.
  query_timeout: 60000,
  lookup: (hostname, options, callback) => { options.family = 4; dns.lookup(hostname, options, callback); }
};

const pool = new Pool(config);

// pg emite 'error' cuando un cliente ocioso muere sin aviso; sin este
// listener EventEmitter lanza el error y el proceso se cae.
pool.on('error', (err) => {
  console.error('❌ Error inesperado en pool de PostgreSQL:', err);
  // pg ya descartó el cliente: la siguiente consulta abre una conexión nueva.
});

// ---------------------------------------------------------------------------
// Reintentos ante cortes de red
//
// Regla de oro: solo se reintenta cuando se sabe que la consulta NO se ejecutó
// (nunca llegó a abrirse la conexión o el servidor la rechazó). Un error
// ambiguo a mitad de consulta (p. ej. ECONNRESET con la respuesta perdida) solo
// se reintenta si la consulta es de solo lectura: en escrituras podría
// duplicar movimientos de inventario.
// ---------------------------------------------------------------------------
const PG_NO_CONEXION = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', // excepciones de conexión
  '53300',                                              // demasiadas conexiones
  '57P01', '57P02', '57P03', '57P04'                    // servidor apagado / no admite conexiones
]);
// Fallas donde nunca se llegó a conectar: seguras de reintentar siempre.
const RED_SEGURA = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN']);
// Fallas de socket que pueden ocurrir después de que la consulta ya se emitió.
const RED_AMBIGUA = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESOCKET']);

function codigoPrimario(err) {
  if (!err) return null;
  if (err.code) return err.code;
  if (err.cause && err.cause.code) return err.cause.code;
  return null;
}

// pg no le pone "code" al timeout de conexión ni al cierre súbito del socket:
// se reconocen por el mensaje.
function esTerminacionDeConexion(err) {
  return /connection (terminated|timeout)/i.test(String((err && err.message) || ''));
}

function consultaNoEjecutada(err) {
  // "Connection terminated due to connection timeout": el handshake nunca
  // terminó, la consulta jamás llegó al servidor. Seguro reintentar.
  if (err && /connection timeout/i.test(String(err.message || ''))) return true;
  const c = codigoPrimario(err);
  return !!c && (PG_NO_CONEXION.has(c) || RED_SEGURA.has(c));
}

function falloAmbiguoDeRed(err) {
  const c = err && err.code;
  if (c && RED_AMBIGUA.has(c)) return true;
  // Socket muerto sin código: puede haberse cortado antes o después de
  // emitir la consulta (ambiguo → solo lecturas).
  return !c && esTerminacionDeConexion(err);
}

function esSoloLectura(sql) {
  const t = String(sql || '').trim().toLowerCase();
  if (/^(select|show|explain)\b/.test(t)) return true;
  if (/^with\b/.test(t)) return !/\b(insert|update|delete)\b/.test(t);
  return false;
}

function reintentarUnaVez(operacion, puedeReintentar, descripcion) {
  return operacion().catch(async (err) => {
    if (!puedeReintentar(err)) throw err;
    console.warn(`⚠️ ${descripcion}: fallo de conexión (${codigoPrimario(err) || err.message}); reintento automático.`);
    // Pausa corta: si fue un parpadeo de red, el segundo intento sale bien.
    await new Promise((resolver) => setTimeout(resolver, 300));
    return operacion();
  });
}

const conectarOriginal = pool.connect.bind(pool);
pool.connect = function (...args) {
  // Estilo callback: se pasa tal cual, sin reintentos.
  if (typeof args[args.length - 1] === 'function') return conectarOriginal(...args);
  // Abrir una conexión no ejecuta consultas: se puede reintentar ante
  // cualquier fallo de red/conexión sin riesgo de duplicar nada.
  return reintentarUnaVez(
    () => conectarOriginal(...args),
    (err) => consultaNoEjecutada(err) || falloAmbiguoDeRed(err) || esTerminacionDeConexion(err),
    'pool.connect()'
  );
};

const queryOriginal = pool.query.bind(pool);
pool.query = function (...args) {
  if (typeof args[args.length - 1] === 'function') return queryOriginal(...args);
  const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
  return reintentarUnaVez(
    () => queryOriginal(...args),
    (err) => consultaNoEjecutada(err) || (falloAmbiguoDeRed(err) && esSoloLectura(sql)),
    'consulta SQL'
  );
};

module.exports = pool;
