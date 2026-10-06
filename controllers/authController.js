const crypto = require('crypto');
const pool = require('../db');
const {
  hashPassword,
  esPasswordHasheada,
  generarToken,
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
      await checkRateLimit({ key: rateLimitKey, maxRequests: 5, windowMs: 5 * 60 * 1000 });
      await pool.query('INSERT INTO historial_accesos (usuario, accion, ip, user_agent, exito, mensaje_error) VALUES ($1, \'LOGIN_FAILED\', $2, $3, false, $4)', [usu, ipCliente(req), req.headers['user-agent'] || '', 'Usuario no existe']);
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
      await checkRateLimit({ key: rateLimitKey, maxRequests: 5, windowMs: 5 * 60 * 1000 });
      await pool.query('INSERT INTO historial_accesos (usuario, accion, ip, user_agent, exito, mensaje_error) VALUES ($1, \'LOGIN_FAILED\', $2, $3, false, $4)', [usu, ipCliente(req), req.headers['user-agent'] || '', 'Contraseña incorrecta']);
      return res.status(401).json({ success: false, mensaje: 'Usuario o contraseña incorrectos' });
    }

    const token = generarToken(user.usuario, user.rol);

    await pool.query('INSERT INTO historial_accesos (usuario, accion, ip, user_agent, exito) VALUES ($1, \'LOGIN\', $2, $3, true)', [user.usuario, ipCliente(req), req.headers['user-agent'] || '']);

    res.json({ success: true, rol: user.rol, usuario: user.usuario, token });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ success: false, mensaje: 'Error en el servidor: ' + err.message });
  }
}

async function listarUsuarios(req, res) {
  try {
    // nombre/cargo/celular son los datos que salen firmados en la OC, asi que
    // la lista tambien los trae para que el admin los complete sin adivinar.
    const result = await pool.query(
      'SELECT id, usuario, rol, nombre, cargo, celular, email FROM usuarios_sistema ORDER BY usuario ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al listar usuarios:', err);
    res.status(500).json({ success: false, mensaje: 'Error al listar usuarios: ' + err.message });
  }
}

/**
 * Normaliza los datos de contacto que se imprimen en la OC.
 * Vienen del formulario del admin y no tienen formato fijo mas alla de "es
 * texto", asi que solo se recorta y se fuerza a cadena. Un dato vacio se
 * guarda como null para que el PDF muestre el guion de "sin dato" en vez de
 * un espacio en blanco que parece un campo sin llenar.
 */
function datosContactoDe(entrada, actual) {
  const base = actual || {};
  const salida = {};
  for (const campo of ['nombre', 'cargo', 'celular', 'email']) {
    const bruto = entrada[campo];
    const valor = bruto === undefined || bruto === null
      ? (base[campo] === undefined ? null : base[campo])
      : String(bruto).trim();
    salida[campo] = valor ? valor : null;
  }
  return salida;
}

async function crearUsuario(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user', $1, true)", [req.usuario || 'admin']);

    const { usu, pwd, rolOk } = req.validated;

    const existe = await client.query('SELECT id FROM usuarios_sistema WHERE LOWER(usuario) = LOWER($1)', [usu]);
    if (existe.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, mensaje: 'El usuario ya existe.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(pwd, salt);
    const contacto = datosContactoDe(req.body, null);
    const result = await client.query(
      'INSERT INTO usuarios_sistema (usuario, password, rol, nombre, cargo, celular, email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, usuario, rol, nombre, cargo, celular, email',
      [usu, `${hash}:${salt}`, rolOk, contacto.nombre, contacto.cargo, contacto.celular, contacto.email]
    );
    await client.query('COMMIT');
    res.json({ success: true, mensaje: 'Usuario creado correctamente.', usuario: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear usuario:', err);
    res.status(500).json({ success: false, mensaje: 'Error al crear usuario: ' + err.message });
  } finally {
    client.release();
  }
}

async function editarUsuario(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user', $1, true)", [req.usuario || 'admin']);

    const id = parseInt(req.params.id, 10);
    const { usuario, rol, password } = req.body;
    if (!Number.isInteger(id) || id <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, mensaje: 'ID de usuario no válido.' });
    }

    const target = await client.query('SELECT * FROM usuarios_sistema WHERE id = $1', [id]);
    if (!target.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, mensaje: 'El usuario no existe.' });
    }
    const targetUser = target.rows[0];

    const nuevoUsuario = (usuario !== undefined && usuario !== null) ? String(usuario).trim() : targetUser.usuario;
    const nuevoRol = (rol !== undefined && rol !== null) ? String(rol).trim() : targetUser.rol;
    const nuevoPassword = (password !== undefined && password !== null) ? String(password) : '';

    if (!/^[A-Za-z0-9_]{3,50}$/.test(nuevoUsuario)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, mensaje: 'El usuario debe tener entre 3 y 50 caracteres (letras, números y guión bajo).' });
    }
    if (!ROLES_PERMITIDOS.includes(nuevoRol)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, mensaje: 'Rol no válido.' });
    }
    if (nuevoPassword && nuevoPassword.length < 6) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, mensaje: 'La contraseña debe tener al menos 6 caracteres.' });
    }
    if (nuevoUsuario.toLowerCase() !== targetUser.usuario.toLowerCase()) {
      const duplicado = await client.query('SELECT id FROM usuarios_sistema WHERE LOWER(usuario) = LOWER($1) AND id <> $2', [nuevoUsuario, id]);
      if (duplicado.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, mensaje: 'Ya existe otro usuario con ese nombre.' });
      }
    }

    if (targetUser.rol === 'admin' && nuevoRol !== 'admin') {
      const admins = await client.query("SELECT COUNT(*)::int AS total FROM usuarios_sistema WHERE rol = 'admin'");
      if (admins.rows[0].total <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, mensaje: 'Debe existir al menos un administrador. No puedes quitar el rol de admin al último administrador.' });
      }
    }

    const contacto = datosContactoDe(req.body, targetUser);

    if (nuevoPassword) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await hashPassword(nuevoPassword, salt);
      await client.query(
        'UPDATE usuarios_sistema SET usuario = $1, rol = $2, password = $3, nombre = $4, cargo = $5, celular = $6, email = $7 WHERE id = $8',
        [nuevoUsuario, nuevoRol, `${hash}:${salt}`, contacto.nombre, contacto.cargo, contacto.celular, contacto.email, id]
      );
    } else {
      await client.query(
        'UPDATE usuarios_sistema SET usuario = $1, rol = $2, nombre = $3, cargo = $4, celular = $5, email = $6 WHERE id = $7',
        [nuevoUsuario, nuevoRol, contacto.nombre, contacto.cargo, contacto.celular, contacto.email, id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, mensaje: 'Usuario actualizado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al editar usuario:', err);
    res.status(500).json({ success: false, mensaje: 'Error al editar usuario: ' + err.message });
  } finally {
    client.release();
  }
}

async function eliminarUsuario(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user', $1, true)", [req.usuario || 'admin']);

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, mensaje: 'ID de usuario no válido.' });
    }

    const target = await client.query('SELECT * FROM usuarios_sistema WHERE id = $1', [id]);
    if (!target.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, mensaje: 'El usuario no existe.' });
    }
    const targetUser = target.rows[0];

    if (targetUser.rol === 'admin') {
      const admins = await client.query("SELECT COUNT(*)::int AS total FROM usuarios_sistema WHERE rol = 'admin'");
      if (admins.rows[0].total <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, mensaje: 'No se puede eliminar al último administrador.' });
      }
    }

    await client.query('DELETE FROM usuarios_sistema WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true, mensaje: 'Usuario eliminado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar usuario:', err);
    res.status(500).json({ success: false, mensaje: 'Error al eliminar usuario: ' + err.message });
  } finally {
    client.release();
  }
}

async function logout(req, res) {
  try {
    await pool.query('INSERT INTO historial_accesos (usuario, accion, ip, user_agent, exito) VALUES ($1, \'LOGOUT\', $2, $3, true)', [req.usuario, ipCliente(req), req.headers['user-agent'] || '']);
    res.json({ success: true, mensaje: 'Sesión cerrada' });
  } catch (err) { res.status(500).json({ success: false, mensaje: err.message }); }
}

module.exports = {
  login,
  listarUsuarios,
  crearUsuario,
  editarUsuario,
  eliminarUsuario,
  logout
};