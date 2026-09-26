const pool = require('../db');
const {
  hashPassword,
  esPasswordHasheada,
  generarToken,
  verificarToken,
  ROLES_PERMITIDOS
} = require('../middleware/auth');
const { checkRateLimit } = require('../services/rateLimiter');

function ipCliente(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : (req.ip || 'local')).toString();
}

async function login(req, res) {
  try {
    const { usuario, password } = req.body;
    const usu = String(usuario || '').trim();
    const pwd = String(password || '');

    if (!usu || !pwd) {
      return res.status(400).json({ success: false, mensaje: 'Ingrese usuario y contraseña.' });
    }

    // Rate limiting con nuevo servicio (5 intentos por 5 minutos por IP+usuario)
    const rateLimitKey = `login:${ipCliente(req)}:${usu}`;
    const rateLimitResult = await checkRateLimit({
      key: rateLimitKey,
      maxRequests: 5,
      windowMs: 5 * 60 * 1000
    });

    if (!rateLimitResult.allowed) {
      return res.status(429).json({
        success: false,
        mensaje: 'Demasiados intentos fallidos. Espere 5 minutos.',
        retryAfter: rateLimitResult.retryAfter
      });
    }

    const result = await pool.query('SELECT * FROM usuarios_sistema WHERE usuario = $1', [usu]);
    const user = result.rows[0];
    if (!user) {
      // Registrar intento fallido (incrementa contador en rate limiter)
      await checkRateLimit({ key: rateLimitKey, maxRequests: 5, windowMs: 5 * 60 * 1000 });
      return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos' });
    }

    let ok = false;
    if (esPasswordHasheada(user.password)) {
      const [hash, salt] = user.password.split(':');
      const calculado = await hashPassword(pwd, salt);
      ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calculado));
    } else {
      ok = user.password === pwd;
      if (ok) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await hashPassword(pwd, salt);
        await pool.query('UPDATE usuarios_sistema SET password = $1 WHERE id = $2', [`${hash}:${salt}`, user.id]);
      }
    }

    if (!ok) {
      // Registrar intento fallido
      await checkRateLimit({ key: rateLimitKey, maxRequests: 5, windowMs: 5 * 60 * 1000 });
      return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos' });
    }

    const token = generarToken(user.usuario, user.rol);
    res.json({ success: true, rol: user.rol, usuario: user.usuario, token });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
  }
}

async function listarUsuarios(req, res) {
  try {
    const result = await pool.query('SELECT id, usuario, rol FROM usuarios_sistema ORDER BY usuario ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al listar usuarios:', err);
    res.status(500).json({ success: false, mensaje: 'Error al listar usuarios: ' + err.message });
  }
}

async function crearUsuario(req, res) {
  try {
    const { usu, pwd, rolOk } = req.validated;

    const existe = await pool.query('SELECT id FROM usuarios_sistema WHERE LOWER(usuario) = LOWER($1)', [usu]);
    if (existe.rows.length) {
      return res.status(409).json({ success: false, mensaje: 'El usuario ya existe.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(pwd, salt);
    const result = await pool.query(
      'INSERT INTO usuarios_sistema (usuario, password, rol) VALUES ($1, $2, $3) RETURNING id, usuario, rol',
      [usu, `${hash}:${salt}`, rolOk]
    );
    res.json({ success: true, mensaje: 'Usuario creado correctamente.', usuario: result.rows[0] });
  } catch (err) {
    console.error('Error al crear usuario:', err);
    res.status(500).json({ success: false, mensaje: 'Error al crear usuario: ' + err.message });
  }
}

async function editarUsuario(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { usuario, rol, password } = req.body;
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, mensaje: 'ID de usuario no válido.' });
    }

    const target = await pool.query('SELECT * FROM usuarios_sistema WHERE id = $1', [id]);
    if (!target.rows.length) {
      return res.status(404).json({ success: false, mensaje: 'El usuario no existe.' });
    }
    const targetUser = target.rows[0];

    const nuevoUsuario = (usuario !== undefined && usuario !== null) ? String(usuario).trim() : targetUser.usuario;
    const nuevoRol = (rol !== undefined && rol !== null) ? String(rol).trim() : targetUser.rol;
    const nuevoPassword = (password !== undefined && password !== null) ? String(password) : '';

    if (!/^[A-Za-z0-9_]{3,50}$/.test(nuevoUsuario)) {
      return res.status(400).json({ success: false, mensaje: 'El usuario debe tener entre 3 y 50 caracteres (letras, números y guión bajo).' });
    }
    if (!ROLES_PERMITIDOS.includes(nuevoRol)) {
      return res.status(400).json({ success: false, mensaje: 'Rol no válido.' });
    }
    if (nuevoPassword && nuevoPassword.length < 6) {
      return res.status(400).json({ success: false, mensaje: 'La contraseña debe tener al menos 6 caracteres.' });
    }
    if (nuevoUsuario.toLowerCase() !== targetUser.usuario.toLowerCase()) {
      const duplicado = await pool.query('SELECT id FROM usuarios_sistema WHERE LOWER(usuario) = LOWER($1) AND id <> $2', [nuevoUsuario, id]);
      if (duplicado.rows.length) {
        return res.status(409).json({ success: false, mensaje: 'Ya existe otro usuario con ese nombre.' });
      }
    }

    if (targetUser.rol === 'admin' && nuevoRol !== 'admin') {
      const admins = await pool.query("SELECT COUNT(*)::int AS total FROM usuarios_sistema WHERE rol = 'admin'");
      if (admins.rows[0].total <= 1) {
        return res.status(400).json({ success: false, mensaje: 'Debe existir al menos un administrador. No puedes quitar el rol de admin al último administrador.' });
      }
    }

    if (nuevoPassword) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await hashPassword(nuevoPassword, salt);
      await pool.query('UPDATE usuarios_sistema SET usuario = $1, rol = $2, password = $3 WHERE id = $4', [nuevoUsuario, nuevoRol, `${hash}:${salt}`, id]);
    } else {
      await pool.query('UPDATE usuarios_sistema SET usuario = $1, rol = $2 WHERE id = $3', [nuevoUsuario, nuevoRol, id]);
    }

    res.json({ success: true, mensaje: 'Usuario actualizado correctamente.' });
  } catch (err) {
    console.error('Error al editar usuario:', err);
    res.status(500).json({ success: false, mensaje: 'Error al editar usuario: ' + err.message });
  }
}

async function eliminarUsuario(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, mensaje: 'ID de usuario no válido.' });
    }

    const target = await pool.query('SELECT * FROM usuarios_sistema WHERE id = $1', [id]);
    if (!target.rows.length) {
      return res.status(404).json({ success: false, mensaje: 'El usuario no existe.' });
    }
    const targetUser = target.rows[0];

    if (targetUser.rol === 'admin') {
      const admins = await pool.query("SELECT COUNT(*)::int AS total FROM usuarios_sistema WHERE rol = 'admin'");
      if (admins.rows[0].total <= 1) {
        return res.status(400).json({ success: false, mensaje: 'No se puede eliminar al último administrador.' });
      }
    }

    await pool.query('DELETE FROM usuarios_sistema WHERE id = $1', [id]);
    res.json({ success: true, mensaje: 'Usuario eliminado correctamente.' });
  } catch (err) {
    console.error('Error al eliminar usuario:', err);
    res.status(500).json({ success: false, mensaje: 'Error al eliminar usuario: ' + err.message });
  }
}

module.exports = {
  login,
  listarUsuarios,
  crearUsuario,
  editarUsuario,
  eliminarUsuario
};