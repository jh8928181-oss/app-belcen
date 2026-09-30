const mockQuery = jest.fn();

// Los clientes transaccionales enrutan BEGIN/COMMIT/ROLLBACK/SET LOCAL sin tocar
// mockQuery, de modo que las consultas "reales" se indexan igual que antes.
const SQL_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i;

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (sql, params) => SQL_CONTROL.test(sql) ? Promise.resolve({ rows: [] }) : mockQuery(sql, params),
    release: () => {}
  })
}));

jest.mock('../services/rateLimiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 4, resetTime: Date.now() + 1000, retryAfter: 0 })
}));

const { hashPassword } = require('../middleware/auth');
const { checkRateLimit } = require('../services/rateLimiter');
const authController = require('../controllers/authController');

/** Crea un res/next falsos y devuelve el estado final tras awaiting el handler. */
function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) { r.cuerpo = cuerpo; return r; }
  };
  return r;
}

async function invocar(handler, req) {
  const res = resFalso();
  await handler(req, res);
  return res;
}

// La contraseña "secreto123" hasheada con este salt, en el formato que espera
// esPasswordHasheada(): <hash scrypt de 64 bytes en hex>:<salt>.
const SALT = 'b'.repeat(32);
const PWD_VALIDA = 'secreto123';
let HASH_REAL;

beforeAll(async () => {
  HASH_REAL = await hashPassword(PWD_VALIDA, SALT);
});

const filaUsuario = (password) => ({ id: 1, usuario: 'juan', rol: 'almacen', password });

beforeEach(() => {
  mockQuery.mockReset();
  checkRateLimit.mockClear();
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4, resetTime: Date.now() + 1000, retryAfter: 0 });
});

describe('login', () => {
  test('devuelve token con credenciales correctas', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [filaUsuario(`${HASH_REAL}:${SALT}`)] });

    const res = await invocar(authController.login, {
      body: { usuario: 'juan', password: PWD_VALIDA },
      headers: {}
    });

    expect(res.cuerpo.success).toBe(true);
    expect(res.cuerpo.rol).toBe('almacen');
    expect(typeof res.cuerpo.token).toBe('string');
    expect(res.statusCode).toBeNull();
  });

  test('responde 400 si faltan usuario o contraseña', async () => {
    const res = await invocar(authController.login, { body: { usuario: 'juan' }, headers: {} });
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('responde 401 si el usuario no existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await invocar(authController.login, {
      body: { usuario: 'fantasma', password: 'secreto123' },
      headers: {}
    });

    expect(res.statusCode).toBe(401);
    expect(res.cuerpo.mensaje).toBe('Usuario o contraseña incorrectos');
  });

  test('responde 401 con contraseña incorrecta', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [filaUsuario(`${HASH_REAL}:${SALT}`)] });

    const res = await invocar(authController.login, {
      body: { usuario: 'juan', password: 'equivocada999' },
      headers: {}
    });

    expect(res.statusCode).toBe(401);
  });

  test('responde 429 cuando el rate limiter bloquea', async () => {
    checkRateLimit.mockResolvedValueOnce({
      allowed: false, remaining: 0, resetTime: Date.now() + 60000, retryAfter: 60
    });

    const res = await invocar(authController.login, {
      body: { usuario: 'juan', password: 'secreto123' },
      headers: {}
    });

    expect(res.statusCode).toBe(429);
    expect(res.cuerpo.retryAfter).toBe(60);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('migra a hash una contraseña guardada en texto plano', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, usuario: 'viejo', rol: 'almacen', password: 'legado123' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await invocar(authController.login, {
      body: { usuario: 'viejo', password: 'legado123' },
      headers: {}
    });

    expect(res.cuerpo.success).toBe(true);
    // La segunda consulta debe ser el UPDATE que reescribe el password.
    const consultaUpdate = mockQuery.mock.calls[1][0];
    expect(consultaUpdate).toMatch(/UPDATE usuarios_sistema/);
    const hashGuardado = mockQuery.mock.calls[1][1][0];
    expect(hashGuardado).toMatch(/^[a-f0-9]{128}:[a-f0-9]{32}$/);
  });

  test('responde 500 si la base de datos falla', async () => {
    mockQuery.mockRejectedValueOnce(new Error('conexión caída'));

    const res = await invocar(authController.login, {
      body: { usuario: 'juan', password: 'secreto123' },
      headers: {}
    });

    expect(res.statusCode).toBe(500);
  });
});

describe('listarUsuarios', () => {
  test('devuelve las filas de la consulta', async () => {
    const filas = [{ id: 1, usuario: 'admin1', rol: 'admin' }];
    mockQuery.mockResolvedValueOnce({ rows: filas });

    const res = await invocar(authController.listarUsuarios, {});
    expect(res.cuerpo).toEqual(filas);
  });

  test('responde 500 si la consulta falla', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fallo'));
    const res = await invocar(authController.listarUsuarios, {});
    expect(res.statusCode).toBe(500);
  });
});

describe('crearUsuario', () => {
  test('crea el usuario con password hasheada', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });                       // no existe
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, usuario: 'nuevo', rol: 'almacen' }] });

    const res = await invocar(authController.crearUsuario, {
      validated: { usu: 'nuevo', pwd: 'secreto123', rolOk: 'almacen' }
    });

    expect(res.cuerpo.success).toBe(true);
    const hashGuardado = mockQuery.mock.calls[1][1][1];
    expect(hashGuardado).toMatch(/^[a-f0-9]{128}:[a-f0-9]{32}$/);
    expect(hashGuardado).not.toContain('secreto123');
  });

  test('responde 409 si el usuario ya existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] });

    const res = await invocar(authController.crearUsuario, {
      validated: { usu: 'juan', pwd: 'secreto123', rolOk: 'almacen' }
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('editarUsuario', () => {
  test('rechaza un id no numérico', async () => {
    const res = await invocar(authController.editarUsuario, { params: { id: 'abc' }, body: {} });
    expect(res.statusCode).toBe(400);
  });

  test('responde 404 si el usuario no existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await invocar(authController.editarUsuario, {
      params: { id: '99' },
      body: { usuario: 'juan', rol: 'almacen' }
    });

    expect(res.statusCode).toBe(404);
  });

  test('rechaza un rol no permitido', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, usuario: 'juan', rol: 'almacen' }] });

    const res = await invocar(authController.editarUsuario, {
      params: { id: '1' },
      body: { rol: 'superusuario' }
    });

    expect(res.statusCode).toBe(400);
  });

  test('responde 409 si el nombre nuevo ya pertenece a otro', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, usuario: 'juan', rol: 'almacen' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    const res = await invocar(authController.editarUsuario, {
      params: { id: '1' },
      body: { usuario: 'maria' }
    });

    expect(res.statusCode).toBe(409);
  });

  test('no permite quitarle el rol de admin al último administrador', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, usuario: 'admin1', rol: 'admin' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const res = await invocar(authController.editarUsuario, {
      params: { id: '1' },
      body: { rol: 'almacen' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/último administrador/);
  });

  test('actualiza sin tocar el password si no se envía', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, usuario: 'juan', rol: 'almacen' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await invocar(authController.editarUsuario, {
      params: { id: '1' },
      body: { rol: 'soplado' }
    });

    expect(res.cuerpo.success).toBe(true);
    expect(mockQuery.mock.calls[1][0]).toMatch(/UPDATE usuarios_sistema/);
    expect(mockQuery.mock.calls[1][0]).not.toMatch(/password/);
  });

  test('rehashea el password cuando se envía uno nuevo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, usuario: 'juan', rol: 'almacen' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await invocar(authController.editarUsuario, {
      params: { id: '1' },
      body: { password: 'nuevaclave123' }
    });

    expect(res.cuerpo.success).toBe(true);
    const hashGuardado = mockQuery.mock.calls[1][1][2];
    expect(hashGuardado).toMatch(/^[a-f0-9]{128}:[a-f0-9]{32}$/);
    expect(hashGuardado).not.toContain('nuevaclave123');
  });
});

describe('eliminarUsuario', () => {
  test('rechaza un id no numérico', async () => {
    const res = await invocar(authController.eliminarUsuario, { params: { id: 'xyz' } });
    expect(res.statusCode).toBe(400);
  });

  test('responde 404 si el usuario no existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await invocar(authController.eliminarUsuario, { params: { id: '42' } });
    expect(res.statusCode).toBe(404);
  });

  test('no permite borrar al último administrador', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, usuario: 'admin1', rol: 'admin' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const res = await invocar(authController.eliminarUsuario, { params: { id: '1' } });

    expect(res.statusCode).toBe(400);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('borra un usuario normal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, usuario: 'juan', rol: 'almacen' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await invocar(authController.eliminarUsuario, { params: { id: '5' } });

    expect(res.cuerpo.success).toBe(true);
    expect(mockQuery.mock.calls[1][0]).toMatch(/DELETE FROM usuarios_sistema/);
  });
});
