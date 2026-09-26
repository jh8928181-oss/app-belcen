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
  ROLES_PERMITIDOS,
  TOKEN_SECRET,
  TOKEN_DURACION_MS
};