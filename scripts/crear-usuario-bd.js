/**
 * Alta puntual de un usuario de Base de Datos General.
 *
 * A diferencia de create-users.js (que borra la tabla y esta pensado para
 * desarrollo), este script hace un solo INSERT con ON CONFLICT DO NOTHING:
 * no pisa la contrasena de nadie y se puede re-ejecutar sin riesgo.
 *
 * No lleva el bloqueo de NODE_ENV=production porque el objetivo es precisamente
 * crear el usuario en Supabase. A cambio exige dos señales explicitas:
 *   ALLOW_CREATE_USER=1        y
 *   CONFIRMAR_ALTA=<usuario>   que debe coincidir con el usuario a crear.
 *
 * Uso (PowerShell):
 *   $env:ALLOW_CREATE_USER='1'
 *   $env:NUEVO_USUARIO='Angelica'
 *   $env:NUEVO_PASSWORD='<la contrasena, sin escribirla aqui>'
 *   $env:NUEVO_ROL='consulta_bd'
 *   $env:CONFIRMAR_ALTA='Angelica'
 *   node scripts/crear-usuario-bd.js
 *
 * Limpiar despues: Remove-Item Env:ALLOW_CREATE_USER, NUEVO_USUARIO,
 * NUEVO_PASSWORD, NUEVO_ROL, CONFIRMAR_ALTA
 */

// db.js exige DATABASE_URL en el entorno pero no carga los .env: eso lo hace
// index.js. Este script corre en su propio proceso, asi que carga los mismos dos
// archivos, en el mismo orden y con el mismo override, para apuntar a la misma
// base activa (Supabase) que la app.
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no esta definido en .env ni en .env.local');
  process.exit(1);
}

const db = require('../db');
const { hashPassword, ROLES_PERMITIDOS, validarUsuarioBody } = require('../middleware/auth');

function salir(mensaje, codigo = 1) {
  console.error(mensaje);
  process.exit(codigo);
}

const usuario = String(process.env.NUEVO_USUARIO || '').trim();
const password = String(process.env.NUEVO_PASSWORD || '');
const rol = String(process.env.NUEVO_ROL || '').trim();

if (process.env.ALLOW_CREATE_USER !== '1') {
  salir('Falta ALLOW_CREATE_USER=1. Este script escribe en la base de datos.');
}
if (!usuario || !password || !rol) {
  salir('Faltan NUEVO_USUARIO, NUEVO_PASSWORD o NUEVO_ROL.');
}
if (process.env.CONFIRMAR_ALTA !== usuario) {
  salir(`CONFIRMAR_ALTA no coincide con el usuario a crear ("${usuario}").`);
}
if (!ROLES_PERMITIDOS.includes(rol)) {
  salir(`Rol no valido: "${rol}". Permitidos: ${ROLES_PERMITIDOS.join(', ')}`);
}

// validarUsuarioBody es middleware: responde 400 o marca req.validated. Se
// simulan req/res/next para reutilizar exactamente sus reglas y no crear un
// usuario que el login despues rechace.
function validar() {
  const reqSimulado = { body: { usuario, password, rol } };
  let mensaje = 'formato rechazado';
  const resSimulado = {
    status(codigo) {
      if (codigo === 400) mensaje = 'formato rechazado';
      return resSimulado;
    },
    json() {}
  };
  validarUsuarioBody(reqSimulado, resSimulado, () => {});
  if (!reqSimulado.validated) {
    salir(`Los datos no pasan las validaciones del sistema (${mensaje}).`);
  }
}

async function main() {
  validar();

  // El login compara exacto (WHERE usuario = $1). Si ya existe una variante con
  // otra capitalizacion, avisar es mejor que dejar dos cuentas que se parecen.
  const { rows: existentes } = await db.query(
    'SELECT usuario, rol FROM usuarios_sistema WHERE LOWER(usuario) = LOWER($1)',
    [usuario]
  );

  if (existentes.length > 0) {
    const actual = existentes[0];
    console.log(`El usuario "${actual.usuario}" ya existe con rol "${actual.rol}".`);
    console.log('No se modifico nada (ON CONFLICT DO NOTHING).');
    await db.end();
    return;
  }

  // Mismo formato que verifica esPasswordHasheada: 64 bytes de scrypt en hex,
  // ':' y el salt de 16 bytes en hex.
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = `${await hashPassword(password, salt)}:${salt}`;

  // El trigger trg_historial_usuarios lee app.current_user para registrar quien
  // hizo el alta; sin esto queda como "system".
  await db.query(`SELECT set_config('app.current_user', $1, true)`, ['scripts/crear-usuario-bd.js']);

  const { rows } = await db.query(
    `INSERT INTO usuarios_sistema (usuario, password, rol)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario) DO NOTHING
     RETURNING id, usuario, rol`,
    [usuario, hash, rol]
  );

  if (rows.length === 0) {
    console.log('No se inserto nada: el usuario aparecio durante la ejecucion.');
  } else {
    console.log(`Usuario creado: ${rows[0].usuario} (id=${rows[0].id}, rol=${rows[0].rol})`);
    console.log('El hash se guardo con el formato del sistema; no se imprime.');
  }

  await db.end();
}

main().catch((err) => {
  console.error('Error creando el usuario:', err.message);
  db.end().finally(() => process.exit(1));
});
