const {
  checkRateLimit,
  rateLimitMiddleware,
  _resetMemoryStore
} = require('../services/rateLimiter');

describe('checkRateLimit (ventana deslizante en memoria)', () => {
  beforeEach(() => {
    _resetMemoryStore();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('permite hasta maxRequests y bloquea al siguiente', async () => {
    const opciones = { key: 'k1', maxRequests: 3, windowMs: 60000 };

    for (let i = 1; i <= 3; i++) {
      const r = await checkRateLimit(opciones);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(3 - i);
    }

    const bloqueado = await checkRateLimit(opciones);
    expect(bloqueado.allowed).toBe(false);
    expect(bloqueado.remaining).toBe(0);
    expect(bloqueado.retryAfter).toBeGreaterThan(0);
  });

  test('retryAfter disminuye conforme pasa el tiempo', async () => {
    const opciones = { key: 'k2', maxRequests: 1, windowMs: 60000 };

    await checkRateLimit(opciones);
    const primerBloqueo = await checkRateLimit(opciones);

    jest.advanceTimersByTime(20000);
    const segundoBloqueo = await checkRateLimit(opciones);

    expect(segundoBloqueo.retryAfter).toBeLessThan(primerBloqueo.retryAfter);
  });

  test('la ventana se reabre cuando expira', async () => {
    const opciones = { key: 'k3', maxRequests: 1, windowMs: 30000 };

    expect((await checkRateLimit(opciones)).allowed).toBe(true);
    expect((await checkRateLimit(opciones)).allowed).toBe(false);

    jest.advanceTimersByTime(31000);

    const despues = await checkRateLimit(opciones);
    expect(despues.allowed).toBe(true);
    expect(despues.remaining).toBe(0);
  });

  test('las claves son independientes entre sí', async () => {
    const a = { key: 'usuario:a', maxRequests: 1, windowMs: 60000 };
    const b = { key: 'usuario:b', maxRequests: 1, windowMs: 60000 };

    expect((await checkRateLimit(a)).allowed).toBe(true);
    expect((await checkRateLimit(a)).allowed).toBe(false);
    expect((await checkRateLimit(b)).allowed).toBe(true);
  });

  test('resetTime es una marca de tiempo futura', async () => {
    const r = await checkRateLimit({ key: 'k4', maxRequests: 5, windowMs: 10000 });
    expect(r.resetTime).toBeGreaterThan(Date.now());
  });
});

describe('rateLimitMiddleware', () => {
  beforeEach(() => {
    _resetMemoryStore();
  });

  test('deja pasar y añade los headers de rate limit', async () => {
    const headers = {};
    const res = {
      set(objeto) { Object.assign(headers, objeto); return res; },
      status() { return { json() {} }; }
    };
    const next = jest.fn();

    await rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 })({ ip: '1.1.1.1' }, res, next);

    expect(next).toHaveBeenCalled();
    // Express convierte los valores de res.set() a string antes de enviarlos;
    // el mock los conserva en crudo.
    expect(String(headers['X-RateLimit-Limit'])).toBe('10');
    expect(String(headers['X-RateLimit-Remaining'])).toBe('9');
    expect(headers['X-RateLimit-Reset']).toBeGreaterThan(Date.now() / 1000 - 1);
  });

  test('responde 429 con Retry-After cuando se excede el límite', async () => {
    const opciones = { maxRequests: 1, windowMs: 60000 };
    const req = { ip: '2.2.2.2' };

    const resOk = { set() { return this; }, status() { return { json() {} }; } };
    await rateLimitMiddleware(opciones)(req, resOk, jest.fn());

    let jsonRecibido = null;
    const resBloqueado = {
      set() { return this; },
      status(codigo) {
        return { json(cuerpo) { jsonRecibido = { codigo, cuerpo }; } };
      }
    };
    const next = jest.fn();
    await rateLimitMiddleware(opciones)(req, resBloqueado, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonRecibido.codigo).toBe(429);
    expect(jsonRecibido.cuerpo.success).toBe(false);
    expect(jsonRecibido.cuerpo.retryAfter).toBeGreaterThan(0);
  });

  test('usa keyGenerator para decidir la clave', async () => {
    const opciones = { keyGenerator: (req) => 'llave:' + req.usuario, maxRequests: 1, windowMs: 60000 };

    const resOk = { set() { return this; }, status() { return { json() {} }; } };
    const nextOk = jest.fn();
    await rateLimitMiddleware(opciones)({ usuario: 'juan' }, resOk, nextOk);
    expect(nextOk).toHaveBeenCalled();

    // Mismo usuario, segunda llamada: debe quedar bloqueado.
    let statusCode = null;
    const resBloqueado = {
      set() { return this; },
      status(codigo) {
        statusCode = codigo;
        return { json() {} };
      }
    };
    const next = jest.fn();
    await rateLimitMiddleware(opciones)({ usuario: 'juan' }, resBloqueado, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusCode).toBe(429);

    // Un usuario distinto tiene su propia cuota.
    const resOtro = { set() { return this; }, status() { return { json() {} }; } };
    const nextOtro = jest.fn();
    await rateLimitMiddleware(opciones)({ usuario: 'maria' }, resOtro, nextOtro);
    expect(nextOtro).toHaveBeenCalled();
  });
});
