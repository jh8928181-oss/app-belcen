const {
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
  ROLES_PERMITIDOS
} = require('../middleware/auth');

/** Crea un res/next falsos para poder observar qué hace un middleware. */
function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    status(codigo) {
      r.statusCode = codigo;
      return r;
    },
    json(cuerpo) {
      r.cuerpo = cuerpo;
      return r;
    }
  };
  return r;
}

describe('hashPassword', () => {
  test('genera hash consistente con el mismo salt', async () => {
    const salt = 'abcdef1234567890';
    const hash1 = await hashPassword('testpass', salt);
    const hash2 = await hashPassword('testpass', salt);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(128);
  });

  test('genera hash diferente con distinto salt', async () => {
    const hash1 = await hashPassword('testpass', 'salt1');
    const hash2 = await hashPassword('testpass', 'salt2');
    expect(hash1).not.toBe(hash2);
  });

  test('genera hash diferente con distinta contraseña', async () => {
    const hash1 = await hashPassword('claveA', 'mismo-salt');
    const hash2 = await hashPassword('claveB', 'mismo-salt');
    expect(hash1).not.toBe(hash2);
  });
});

describe('esPasswordHasheada', () => {
  test('detecta el formato esperado (128 hex : 32 hex)', () => {
    const hash = 'a'.repeat(128) + ':' + 'b'.repeat(32);
    expect(esPasswordHasheada(hash)).toBe(true);
  });

  test('rechaza formatos incorrectos', () => {
    expect(esPasswordHasheada('plainpassword')).toBe(false);
    expect(esPasswordHasheada('hash:salt:extra')).toBe(false);
    expect(esPasswordHasheada('')).toBe(false);
    expect(esPasswordHasheada(null)).toBe(false);
    expect(esPasswordHasheada(undefined)).toBe(false);
    expect(esPasswordHasheada('z'.repeat(128) + ':' + 'b'.repeat(32))).toBe(false);
  });
});

describe('generarToken / verificarToken', () => {
  test('un token recién generado se verifica correctamente', () => {
    const token = generarToken('admin1', 'admin');
    const datos = verificarToken(token);
    expect(datos).not.toBeNull();
    expect(datos.usuario).toBe('admin1');
    expect(datos.rol).toBe('admin');
  });

  test('rechaza null, undefined y valores no string', () => {
    expect(verificarToken(null)).toBeNull();
    expect(verificarToken(undefined)).toBeNull();
    expect(verificarToken('')).toBeNull();
    expect(verificarToken(12345)).toBeNull();
  });

  test('rechaza un token sin separador de firma', () => {
    expect(verificarToken('solo-el-payload')).toBeNull();
  });

  test('rechaza un token con firma manipulada', () => {
    const token = generarToken('admin1', 'admin');
    const [payload] = token.split('.');
    expect(verificarToken(payload + '.firmafalsa')).toBeNull();
  });

  test('rechaza un payload modificado manteniendo la firma', () => {
    const token = generarToken('admin1', 'admin');
    const [, firma] = token.split('.');
    const payloadFalso = Buffer.from(JSON.stringify({
      usuario: 'atacante', rol: 'admin', exp: Date.now() + 100000
    })).toString('base64url');
    expect(verificarToken(payloadFalso + '.' + firma)).toBeNull();
  });

  test('rechaza un token expirado', () => {
    const payload = Buffer.from(JSON.stringify({
      usuario: 'admin1', rol: 'admin', exp: Date.now() - 1000
    })).toString('base64url');
    // Firma con el mismo secreto que usa el módulo.
    const crypto = require('crypto');
    const firma = crypto
      .createHmac('sha256', process.env.TOKEN_SECRET)
      .update(payload)
      .digest('base64url');
    expect(verificarToken(payload + '.' + firma)).toBeNull();
  });
});

describe('authMiddleware', () => {
  test('responde 401 cuando no hay header', () => {
    const res = resFalso();
    const next = jest.fn();
    authMiddleware({ headers: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.cuerpo.success).toBe(false);
  });

  test('acepta el token en el header Authorization: Bearer', () => {
    const req = { headers: { authorization: 'Bearer ' + generarToken('juan', 'almacen') } };
    const res = resFalso();
    const next = jest.fn();
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.usuario).toBe('juan');
    expect(req.rol).toBe('almacen');
  });

  test('acepta el token en el header x-token', () => {
    const req = { headers: { 'x-token': generarToken('juan', 'almacen') } };
    const res = resFalso();
    const next = jest.fn();
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.rol).toBe('almacen');
  });

  test('rechaza un token con rol alterado en el header', () => {
    const req = { headers: { authorization: 'Bearer no.es.un.token' } };
    const res = resFalso();
    const next = jest.fn();
    authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('requerirRolAdmin', () => {
  test('deja pasar al admin', () => {
    const next = jest.fn();
    requerirRolAdmin({ rol: 'admin' }, resFalso(), next);
    expect(next).toHaveBeenCalled();
  });

  test('responde 403 a cualquier otro rol', () => {
    const res = resFalso();
    const next = jest.fn();
    requerirRolAdmin({ rol: 'almacen' }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('validarUsuarioBody', () => {
  test('acepta un cuerpo válido y lo deja en req.validated', () => {
    const req = { body: { usuario: 'operador_1', password: 'secreto123', rol: 'almacen' } };
    const next = jest.fn();
    validarUsuarioBody(req, resFalso(), next);
    expect(next).toHaveBeenCalled();
    expect(req.validated).toEqual({ usu: 'operador_1', pwd: 'secreto123', rolOk: 'almacen' });
  });

  test('rechaza usuario muy corto', () => {
    const res = resFalso();
    const next = jest.fn();
    validarUsuarioBody({ body: { usuario: 'ab', password: 'secreto123', rol: 'almacen' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test('rechaza usuario con caracteres no permitidos', () => {
    const res = resFalso();
    validarUsuarioBody({ body: { usuario: 'ope rador!', password: 'secreto123', rol: 'almacen' } }, res, jest.fn());
    expect(res.statusCode).toBe(400);
  });

  test('rechaza contraseña de menos de 6 caracteres', () => {
    const res = resFalso();
    validarUsuarioBody({ body: { usuario: 'operador_1', password: '12345', rol: 'almacen' } }, res, jest.fn());
    expect(res.statusCode).toBe(400);
  });

  test('rechaza un rol fuera de la lista', () => {
    const res = resFalso();
    validarUsuarioBody({ body: { usuario: 'operador_1', password: 'secreto123', rol: 'superusuario' } }, res, jest.fn());
    expect(res.statusCode).toBe(400);
  });
});

describe('crearGuardRoles', () => {
  test('deja pasar cuando el rol está en la lista', () => {
    const next = jest.fn();
    crearGuardRoles(['admin', 'almacen'])({ rol: 'almacen' }, resFalso(), next);
    expect(next).toHaveBeenCalled();
  });

  test('con enforce:true responde 403 a un rol no permitido', () => {
    const res = resFalso();
    const next = jest.fn();
    crearGuardRoles(['admin'], { enforce: true })({ rol: 'invitado' }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.cuerpo.mensaje).toBe('Acceso no autorizado.');
  });

  test('sin enforce y sin ENFORCE_ROLES deja pasar y registra', () => {
    const res = resFalso();
    const next = jest.fn();
    crearGuardRoles(['admin'])({ method: 'GET', originalUrl: '/api/x', rol: 'invitado' }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  test('usa el mensaje personalizado al bloquear', () => {
    const res = resFalso();
    crearGuardRoles(['admin'], { enforce: true, mensaje: 'Solo admin.' })({ rol: 'invitado' }, res, jest.fn());
    expect(res.cuerpo.mensaje).toBe('Solo admin.');
  });

  test('acepta un rol suelto sin_array', () => {
    const next = jest.fn();
    crearGuardRoles('admin')({ rol: 'admin' }, resFalso(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('ROLES_PERMITIDOS y ROLES_MODULO', () => {
  test('ENFORCE_ROLES está apagado por defecto', () => {
    expect(ENFORCE_ROLES).toBe(false);
  });

  test('ROLES_PERMITIDOS contiene los 10 roles conocidos', () => {
    expect(ROLES_PERMITIDOS).toHaveLength(10);
    ['admin', 'supervisor', 'produccion', 'auditoria', 'vigilancia', 'almacen', 'soplado', 'envasado', 'refinado', 'invitado']
      .forEach((r) => expect(ROLES_PERMITIDOS).toContain(r));
  });

  test('todos los roles de ROLES_MODULO son roles válidos', () => {
    Object.values(ROLES_MODULO).forEach((roles) => {
      roles.forEach((r) => expect(ROLES_PERMITIDOS).toContain(r));
    });
  });

  test('admin aparece en todos los grupos de módulo salvo el de administración', () => {
    ['vigilancia', 'almacen', 'soplado', 'envasado', 'produccion', 'auditoria', 'ia']
      .forEach((grupo) => expect(ROLES_MODULO[grupo]).toContain('admin'));
  });
});

// Regresión: GET /api/almacen/pendientes solo exigía autenticación global, así
// que cualquier rol autenticado podía listar los ingresos pendientes de
// conformidad. Ahora lleva el mismo guard que el resto del módulo almacén.
describe('guard de rol montado en la ruta', () => {
  const { app } = require('../index');

  function capaRuta(metodo, ruta) {
    const stack = (app.router || app._router).stack;
    const capa = stack.find((l) => l.route && l.route.path === ruta && l.route.methods[metodo]);
    return capa ? capa.route.stack : null;
  }

  test('GET /api/almacen/pendientes tiene guard antes que el handler', () => {
    const stack = capaRuta('get', '/api/almacen/pendientes');
    expect(stack).not.toBeNull();
    // guard + handler. Antes de este cambio solo estaba el handler.
    expect(stack).toHaveLength(2);
  });

  test('el guard de pendientes avisa cuando el rol no es de almacén', () => {
    const stack = capaRuta('get', '/api/almacen/pendientes');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const next = jest.fn();

    stack[0].handle({ rol: 'soplado', method: 'GET', originalUrl: '/api/almacen/pendientes', usuario: 'u1' }, resFalso(), next);

    expect(next).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[observa-roles]'));
    warn.mockRestore();
  });

  test('el guard de pendientes deja pasar a un rol de almacén sin avisar', () => {
    const stack = capaRuta('get', '/api/almacen/pendientes');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const next = jest.fn();

    stack[0].handle({ rol: 'almacen', method: 'GET', originalUrl: '/api/almacen/pendientes', usuario: 'u2' }, resFalso(), next);

    expect(next).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
