const crypto = require('crypto');
const { promisify } = require('util');
const scryptP = promisify(crypto.scrypt);

const TOKEN_SECRET = process.env.TOKEN_SECRET || 'belcen-clave-sesion-cambiar-en-produccion';
const TOKEN_DURACION_MS = 8 * 60 * 60 * 1000;

async function hashPassword(password, salt) {
  const buf = await scryptP(password, salt, 64);
  return buf.toString('hex');
}

function esPasswordHasheada(stored) {
  return typeof stored === 'string' && /^[a-f0-9]{128}:[a-f0-9]{32}$/.test(stored);
}

function generarToken(usuario, rol) {
  const payload = Buffer.from(JSON.stringify({ usuario, rol, exp: Date.now() + TOKEN_DURACION_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verificarToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const sigEsperado = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sigEsperado);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const datos = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!datos || Date.now() > datos.exp) return null;
    return datos;
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-token'] || '');
  const datos = verificarToken(token);
  if (!datos) {
    return res.status(401).json({ success: false, mensaje: 'Sesión no válida o expirada. Inicie sesión nuevamente.' });
  }
  req.usuario = datos.usuario;
  req.rol = datos.rol;
  next();
}

function requerirRolAdmin(req, res, next) {
  if (req.rol !== 'admin') {
    return res.status(403).json({ success: false, mensaje: 'Solo el administrador puede gestionar usuarios.' });
  }
  next();
}

const ROLES_PERMITIDOS = ['admin', 'supervisor', 'produccion', 'auditoria', 'vigilancia', 'almacen', 'soplado', 'envasado', 'refinado', 'invitado'];

/**
 * Control de acceso por rol.
 *
 * Por defecto corre en MODO OBSERVACIÓN: no bloquea, solo registra en consola
 * los accesos que quedarían rechazados. Así se pueden gathered los roles reales
 * que usa la planta antes de activar el bloqueo, sin arriesgar dejar fuera a
 * nadie. Se activa poniendo ENFORCE_ROLES=true en el entorno.
 */
const ENFORCE_ROLES = /^(1|true|yes|si|sí)$/i.test(String(process.env.ENFORCE_ROLES || '').trim());

/**
 * Crea un middleware que restringe una ruta a los roles indicados.
 * @param {string[]|string[]} roles - Roles permitidos
 * @param {{enforce?: boolean, mensaje?: string}} [opciones]
 *   enforce: fuerza el bloqueo aunque ENFORCE_ROLES esté apagado.
 *   Se usa en las rutas que ya estaban protegidas antes de este mecanismo.
 * @returns {Function} Middleware Express
 */
function crearGuardRoles(roles, opciones = {}) {
  const { enforce = false, mensaje = 'Acceso no autorizado.' } = opciones;
  const permitidos = [].concat(roles);

  return function(req, res, next) {
    if (permitidos.includes(req.rol)) return next();

    if (enforce || ENFORCE_ROLES) {
      return res.status(403).json({ success: false, mensaje });
    }

    console.warn(
      `[observa-roles] ${req.method} ${req.originalUrl} | usuario=${req.usuario || '-'} rol=${req.rol || '-'} ` +
      `| permitidos=${permitidos.join(',')}`
    );
    next();
  };
}

/** Grupos de roles por módulo, derivados del mapa de acceso de dashboard.html:463-465 */
const ROLES_MODULO = {
  admin: ['admin'],
  supervision: ['admin', 'supervisor'],
  vigilancia: ['admin', 'supervisor', 'vigilancia'],
  almacen: ['admin', 'supervisor', 'almacen'],
  soplado: ['admin', 'supervisor', 'soplado'],
  envasado: ['admin', 'supervisor', 'envasado', 'produccion'],
  produccion: ['admin', 'supervisor', 'produccion'],
  auditoria: ['admin', 'supervisor', 'auditoria', 'produccion'],
  // Lectura de documentos con IA: consume la cuota de Gemini, no se restringe por módulo.
  ia: ['admin', 'supervisor', 'vigilancia', 'almacen', 'soplado', 'envasado', 'refinado', 'auditoria', 'produccion']
};

function validarUsuarioBody(req, res, next) {
  const { usuario, password, rol } = req.body;
  const usu = String(usuario || '').trim();
  const pwd = String(password || '');
  const rolOk = String(rol || '').trim();

  if (!/^[A-Za-z0-9_]{3,50}$/.test(usu)) {
    return res.status(400).json({ success: false, mensaje: 'El usuario debe tener entre 3 y 50 caracteres (letras, números y guión bajo).' });
  }
  if (pwd.length < 6) {
    return res.status(400).json({ success: false, mensaje: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  if (!ROLES_PERMITIDOS.includes(rolOk)) {
    return res.status(400).json({ success: false, mensaje: 'Rol no válido.' });
  }
  req.validated = { usu, pwd, rolOk };
  next();
}

module.exports = {
  hashPassword,
  esPasswordHasheada,
  generarToken,
  verificarToken,
  authMiddleware,
  requerirRolAdmin,
  validarUsuarioBody,
  crearGuardRoles,
  ROLES_MODULO,
  ENFORCE_ROLES,
  ROLES_PERMITIDOS,
  TOKEN_SECRET,
  TOKEN_DURACION_MS
};