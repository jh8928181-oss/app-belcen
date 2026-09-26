/**
 * Rate Limiter flexible: usa Redis si está disponible, sino usa memoria (Map)
 * Compatible con el middleware de login existente
 */

let redisClient = null;
let useRedis = false;

// Intentar inicializar Redis si hay URL configurada
async function initRedis() {
  if (!process.env.REDIS_URL) {
    console.log('⚠️  REDIS_URL no configurado, usando rate limiter en memoria');
    return false;
  }

  try {
    // Intentar importar ioredis dinámicamente
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      enableReadyCheck: true,
      lazyConnect: true
    });

    redisClient.on('error', (err) => {
      console.error('❌ Error Redis:', err.message);
      useRedis = false;
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis conectado para rate limiting');
      useRedis = true;
    });

    await redisClient.connect();
    return true;
  } catch (err) {
    console.log('⚠️  No se pudo conectar a Redis, usando memoria:', err.message);
    return false;
  }
}

// Almacén en memoria como fallback
const memoryStore = new Map();

// Limpieza periódica de memoria
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of memoryStore.entries()) {
    if (record.resetTime < now) {
      memoryStore.delete(key);
    }
  }
}, 60 * 60 * 1000); // Cada hora

/**
 * Rate limiter con sliding window
 * @param {Object} options
 * @param {string} options.key - Clave única (ej: "login:192.168.1.1:usuario")
 * @param {number} options.maxRequests - Máximo requests permitidos
 * @param {number} options.windowMs - Ventana de tiempo en ms
 * @returns {Object} { allowed: boolean, remaining: number, resetTime: number, retryAfter: number }
 */
async function checkRateLimit({ key, maxRequests = 5, windowMs = 5 * 60 * 1000 }) {
  const now = Date.now();
  const windowStart = now - windowMs;

  if (useRedis && redisClient) {
    try {
      // Usar sorted set en Redis para sliding window
      const redisKey = `ratelimit:${key}`;

      // Eliminar entradas antiguas
      await redisClient.zremrangebyscore(redisKey, 0, windowStart);

      // Contar requests actuales
      const currentCount = await redisClient.zcard(redisKey);

      if (currentCount >= maxRequests) {
        // Obtener el timestamp del request más antiguo para calcular retryAfter
        const oldest = await redisClient.zrange(redisKey, 0, 0, 'WITHSCORES');
        const resetTime = oldest.length > 1 ? parseInt(oldest[1]) + windowMs : now + windowMs;
        return {
          allowed: false,
          remaining: 0,
          resetTime,
          retryAfter: Math.ceil((resetTime - now) / 1000)
        };
      }

      // Agregar request actual
      await redisClient.zadd(redisKey, now, `${now}:${Math.random()}`);
      await redisClient.expire(redisKey, Math.ceil(windowMs / 1000) + 1);

      return {
        allowed: true,
        remaining: maxRequests - currentCount - 1,
        resetTime: now + windowMs,
        retryAfter: 0
      };
    } catch (err) {
      console.error('Error en rate limiter Redis, fallback a memoria:', err.message);
      useRedis = false;
    }
  }

  // Fallback a memoria
  const record = memoryStore.get(key) || { requests: [], resetTime: now + windowMs };

  // Filtrar requests dentro de la ventana
  record.requests = record.requests.filter(timestamp => timestamp > windowStart);

  if (record.requests.length >= maxRequests) {
    const oldest = record.requests[0];
    const resetTime = oldest + windowMs;
    return {
      allowed: false,
      remaining: 0,
      resetTime,
      retryAfter: Math.ceil((resetTime - now) / 1000)
    };
  }

  // Agregar request actual
  record.requests.push(now);
  memoryStore.set(key, record);

  return {
    allowed: true,
    remaining: maxRequests - record.requests.length,
    resetTime: now + windowMs,
    retryAfter: 0
  };
}

/**
 * Middleware de rate limiting para Express
 * @param {Object} options
 * @param {Function} options.keyGenerator - Función que genera la clave a partir del req
 * @param {number} options.maxRequests
 * @param {number} options.windowMs
 * @param {string} options.message - Mensaje de error personalizado
 */
function rateLimitMiddleware(options = {}) {
  const {
    keyGenerator = (req) => req.ip,
    maxRequests = 100,
    windowMs = 15 * 60 * 1000,
    message = 'Demasiadas solicitudes. Intente más tarde.'
  } = options;

  return async (req, res, next) => {
    const key = keyGenerator(req);
    const result = await checkRateLimit({ key, maxRequests, windowMs });

    // Headers estándar de rate limiting
    res.set({
      'X-RateLimit-Limit': maxRequests,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000)
    });

    if (!result.allowed) {
      res.set('Retry-After', result.retryAfter);
      return res.status(429).json({ success: false, mensaje: message, retryAfter: result.retryAfter });
    }

    next();
  };
}

/**
 * Cierra la conexión Redis si existe
 */
async function shutdown() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    useRedis = false;
  }
}

// Inicializar Redis al cargar el módulo (no await para no bloquear)
initRedis().catch(() => {});

module.exports = {
  checkRateLimit,
  rateLimitMiddleware,
  initRedis,
  shutdown,
  isUsingRedis: () => useRedis
};