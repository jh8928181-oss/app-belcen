/**
 * Tests del cuadro "Produccion a base de insumos".
 *
 * Reglas que se cuidan aqui:
 *  1. Cada producto con receta vigente aparece con su envase (botella,
 *     galonera, balde o lata) convertido de UNIDADES a cajas.
 *  2. El alcance en tapas usa la tapa por defecto de la receta; cuando la
 *     tapa es elegible, los colores alternativos se devuelven como
 *     sugerencias (sin la de por defecto).
 *  3. "Cajas posibles (todo)" es el minimo entre TODOS los insumos
 *     obligatorios, no solo el envase.
 */
const mockQuery = jest.fn();

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (...args) => mockQuery(...args),
    release: () => {}
  })
}));

// Solo se anula la autenticacion; el service se ejerce de verdad salvo las
// partes que leen la base (obtenerRecetaVigente / calcularInsumosDeReceta).
jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, authMiddleware: (req, res, next) => next() };
});

const mockObtenerRecetaVigente = jest.fn();
const mockCalcularInsumos = jest.fn();

jest.mock('../services/recipeService', () => {
  const real = jest.requireActual('../services/recipeService');
  return {
    ...real,
    obtenerRecetaVigente: (...args) => mockObtenerRecetaVigente(...args),
    calcularInsumosDeReceta: (...args) => mockCalcularInsumos(...args)
  };
});

const { app } = require('../index');

function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) {
      if (r.statusCode === null) r.statusCode = 200;
      r.cuerpo = cuerpo;
      return r;
    }
  };
  return r;
}

function pilaDe(method, ruta) {
  const pila = app.router ? app.router.stack : app._router.stack;
  const mio = ruta.split('/');
  const encaja = (registrado, solicitado) =>
    registrado.startsWith(':') || registrado.toLowerCase() === solicitado.toLowerCase();
  const candidatas = pila.filter(l => {
    if (!l.route || !l.route.methods[method]) return false;
    const suyo = l.route.path.split('/');
    return suyo.length === mio.length && suyo.every((seg, i) => encaja(seg, mio[i]));
  });
  if (!candidatas.length) throw new Error(`No existe la ruta ${method.toUpperCase()} ${ruta}`);
  return candidatas.pop().route.stack.map(l => l.handle);
}

async function invocar(method, ruta) {
  const res = resFalso();
  const peticion = {
    params: {}, body: {}, query: {}, usuario: 'admin1', rol: 'admin',
    headers: {}, method, originalUrl: ruta
  };
  const capas = pilaDe(method, ruta);
  await new Promise(resolve => {
    let i = 0;
    const siguiente = () => {
      if (i >= capas.length) return resolve();
      const capa = capas[i++];
      const ultima = i >= capas.length;
      Promise.resolve(capa(peticion, res, siguiente)).then(
        () => { if (ultima || res.cuerpo !== null) resolve(); },
        () => resolve()
      );
    };
    siguiente();
  });
  return res;
}

const hoja = over => Object.assign({
  cantidad_por_caja: 1, cantidad: 1, obligatorio: true, stock_minimo: null
}, over);

beforeEach(() => {
  mockQuery.mockReset();
  mockObtenerRecetaVigente.mockReset();
  mockCalcularInsumos.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('GET /api/produccion/base-insumos', () => {
  test('convierte el stock de envase a cajas y evalua el alcance de tapas', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/SELECT DISTINCT producto_key FROM recetas/.test(sql)) {
        return { rows: [{ producto_key: 'belini_1lt' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    mockObtenerRecetaVigente.mockResolvedValue({
      id: 10, producto_key: 'belini_1lt', nombre_producto: 'Aceite de Soya Belini 1 Lt',
      insumos: [{ id: 1, insumo_id: 2, seleccionable: false, opciones: [] }]
    });
    // 1200 botellas / 12 por caja = 100 cajas; tapa alcanza para 2503.
    mockCalcularInsumos.mockResolvedValue([
      hoja({ insumo_id: 1, nombre: 'Botella Belini x 1 Lt', unidad: 'UNIDADES', categoria: 'BOTELLAS Y GALONERAS', stock_actual: 1200, cantidad_por_caja: 12, cantidad: 12 }),
      hoja({ insumo_id: 2, nombre: 'Tapa dosif. N° 26 blanco / Dorado', unidad: 'MILL', categoria: 'TAPAS Y ACCESORIOS', stock_actual: 30.04, cantidad_por_caja: 0.012, cantidad: 0.012 }),
      hoja({ insumo_id: 3, nombre: 'CAJA BELINI X 1 LITRO', unidad: 'UNIDADES', categoria: 'CAJAS', stock_actual: 8184, cantidad_por_caja: 1, cantidad: 1 })
    ]);

    const res = await invocar('get', '/api/produccion/base-insumos');
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    expect(res.cuerpo.productos).toHaveLength(1);

    const p = res.cuerpo.productos[0];
    expect(p.producto_key).toBe('belini_1lt');
    expect(p.envase_nombre).toBe('Botella Belini x 1 Lt');
    expect(p.stock_envase).toBe(1200);
    expect(p.envase_por_caja).toBe(12);
    expect(p.cajas_por_envase).toBe(100);
    expect(p.tapa.nombre).toBe('Tapa dosif. N° 26 blanco / Dorado');
    expect(p.tapa.cajas_alcance).toBe(2503);
    expect(p.sugerencias).toEqual([]);
    // El cuello de botella es el envase (100), no la caja (8184).
    expect(p.cajas_maximas).toBe(100);
  });

  test('la tapa elegible sugiere los colores alternativos con su alcance', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/SELECT DISTINCT producto_key FROM recetas/.test(sql)) {
        return { rows: [{ producto_key: 'faisan_1lt' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    mockObtenerRecetaVigente.mockResolvedValue({
      id: 20, producto_key: 'faisan_1lt', nombre_producto: 'Aceite Faisan 1 Lt',
      insumos: [{
        id: 77, insumo_id: 35, seleccionable: true,
        opciones: [
          { insumo_id: 35, nombre: 'Tapa dosif. N° 26 blanco / Dorado', unidad_medida: 'MILL', stock: 30.04 },
          { insumo_id: 68, nombre: 'Tapa Dosif. N° 26 blanco / ROJO', unidad_medida: 'MILL', stock: 49.92 },
          { insumo_id: 69, nombre: 'Tapa Dosif. N° 26 blanco / VERDE', unidad_medida: 'MILL', stock: 26.89 }
        ]
      }]
    });
    mockCalcularInsumos.mockResolvedValue([
      hoja({ insumo_id: 84, nombre: 'Botella Faisan x 1 lt', unidad: 'UNIDADES', categoria: 'BOTELLAS Y GALONERAS', stock_actual: 13522, cantidad_por_caja: 12, cantidad: 12 }),
      // La hoja de tapa resuelve la OPCION POR DEFECTO (dorada, id 35).
      hoja({ insumo_id: 35, nombre: 'Tapa dosif. N° 26 blanco / Dorado', unidad: 'MILL', categoria: 'TAPAS Y ACCESORIOS', stock_actual: 30.04, cantidad_por_caja: 0.012, cantidad: 0.012 })
    ]);

    const res = await invocar('get', '/api/produccion/base-insumos');
    expect(res.statusCode).toBe(200);
    const p = res.cuerpo.productos[0];
    // La tapa principal sigue siendo la de defecto.
    expect(p.tapa.nombre).toBe('Tapa dosif. N° 26 blanco / Dorado');
    expect(p.tapa.cajas_alcance).toBe(2503);
    // Las sugerencias excluyen la de defecto y traen el alcance de cada color.
    expect(p.sugerencias).toHaveLength(2);
    const rojo = p.sugerencias.find(s => /ROJO/.test(s.nombre));
    const verde = p.sugerencias.find(s => /VERDE/.test(s.nombre));
    expect(rojo.cajas_alcance).toBe(4160);
    expect(verde.cajas_alcance).toBe(2240);
    // Envase: 13522 botellas / 12 = 1126 cajas; las tapas alcanzan.
    expect(p.cajas_por_envase).toBe(1126);
    expect(p.tapa.cajas_alcance).toBeGreaterThanOrEqual(p.cajas_por_envase);
  });

  test('un producto sin stock de envase da 0 cajas y el error de uno no frena a los demas', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/SELECT DISTINCT producto_key FROM recetas/.test(sql)) {
        return {
          rows: [{ producto_key: 'b1_200ml' }, { producto_key: 'belini_500ml' }],
          rowCount: 2
        };
      }
      return { rows: [], rowCount: 0 };
    });
    mockObtenerRecetaVigente.mockImplementation(async key => {
      if (key === 'b1_200ml') throw new Error('receta rota');
      return {
        id: 30, producto_key: key, nombre_producto: 'Aceite Belini 500 ml',
        insumos: [{ id: 1, insumo_id: 2, seleccionable: false, opciones: [] }]
      };
    });
    mockCalcularInsumos.mockResolvedValue([
      hoja({ insumo_id: 10, nombre: 'Botella Belini x 500 ml', unidad: 'UNIDADES', categoria: 'BOTELLAS Y GALONERAS', stock_actual: 0, cantidad_por_caja: 12, cantidad: 12 }),
      hoja({ insumo_id: 2, nombre: 'Tapa dosif. N° 26 blanco / Dorado', unidad: 'MILL', categoria: 'TAPAS Y ACCESORIOS', stock_actual: 30.04, cantidad_por_caja: 0.012, cantidad: 0.012 })
    ]);

    const res = await invocar('get', '/api/produccion/base-insumos');
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.productos).toHaveLength(1);
    expect(res.cuerpo.productos[0].producto_key).toBe('belini_500ml');
    expect(res.cuerpo.productos[0].cajas_por_envase).toBe(0);
  });
});
