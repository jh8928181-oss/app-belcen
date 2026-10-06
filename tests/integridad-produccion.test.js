/**
 * Pruebas de integridad en produccion: linea en marcha, clave del producto,
 * devolucion parcial de cajas y validacion entera.
 *
 * Cada caso de aqui protege un fallo concreto que antes dejaba el inventario mal:
 *
 *   A1. `estado_lineas` se escribia y se pintaba, pero ninguna ruta de produccion la
 *       consultaba. Una linea en PARADO followed sumando producto terminado, y el
 *       indicador no describia nada real. Ahora bloquea con 409.
 *
 *   C1. El reporte se bloqueaba con SELECT normal y luego se borraba sin mirar
 *       rowCount. Dos borrados simultaneos devolvian los insumos dos veces.
 *
 *   C2. Al borrar se re-resolvia el producto por el nombre de la receta actual. Si
 *       la receta se desactivaba o renombraba entre la produccion y el borrado, los
 *       insumos volaban (van por snapshot) pero las cajas no: se perdian. Ahora la
 *       clave se guarda al producir y esa clave manda al borrar.
 *
 *   C3. La devolucion de cajas era una resta ciega. Con las cajas ya despachadas
 *       reventaba contra el CHECK stock_cajas >= 0 y el ROLLBACK arrastraba la
 *       devolucion de insumos: el reporte no se podia borrar de ninguna forma.
 *
 *   M2. stock_cajas es integer. Un 10.7 pasaba la validacion y Postgres respondia
 *       con un error de tipo en vez de un 400 con mensaje util.
 *
 * Las rutas viven en index.js, no en un router aparte, asi que se alcanzan por el
 * app exportado recorriendo su pila, igual que un router.
 */

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const fs = require('fs');
const path = require('path');

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (...args) => mockQuery(...args),
    release: (...args) => mockRelease(...args)
  })
}));

// El guard por rol se ejerce de verdad (ver describe de acceso); solo se anula la
// autenticacion, porque req.usuario lo pone cada test.
jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, authMiddleware: (req, res, next) => next() };
});

const { app } = require('../index');

function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    headersSent: false,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) {
      if (r.statusCode === null) r.statusCode = 200;
      r.cuerpo = cuerpo;
      r.headersSent = true;
      return r;
    }
  };
  return r;
}

/** Igual que en routes.bd-precios: gana la ruta literal sobre la de parametro. */
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
  const literales = candidatas.filter(l => l.route.path.indexOf(':') < 0);
  return (literales.length ? literales : candidatas).pop().route.stack.map(l => l.handle);
}

async function invocar(method, ruta, req = {}) {
  const res = resFalso();
  const peticion = Object.assign(
    { params: {}, body: {}, query: {}, usuario: 'envasado_user', rol: 'envasado', headers: {}, method, originalUrl: ruta },
    req
  );
  const capas = pilaDe(method, ruta);
  await new Promise(resolve => {
    let i = 0;
    const siguiente = () => {
      if (i >= capas.length) return resolve();
      const capa = capas[i++];
      const ultima = i >= capas.length;
      Promise.resolve(capa(peticion, res, siguiente)).then(
        () => { if (ultima || res.headersSent) resolve(); },
        () => { if (ultima || res.headersSent) resolve(); }
      );
    };
    siguiente();
  });
  return res;
}

/** Todo lo que la transaccion leyo o escribio, en orden, para poder afirmar sobre el. */
function registro() {
  return mockQuery.mock.calls.map(c => ({ sql: String(c[0]), params: c[1] }));
}

const sqlDe = (patron) => registro().filter(c => c.sql.includes(patron));
const limpia = () => mockQuery.mockClear();

/** Reporte tal como lo devuelve la base, con el snapshot de insumos que se guardo. */
function reporteGuardado(extra = {}) {
  return Object.assign({
    id: 9,
    fecha_produccion: '2026-09-21',
    presentacion: 'Aceite de Soya Belini 1 Lt',
    cantidad_cajas: 500,
    unidad_medida: 'CAJAS',
    toneladas: 1.4,
    observaciones: '',
    usuario_registro: 'envasado_user',
    producto_key: 'belini_1lt',
    desglose_insumos: JSON.stringify([
      { articulo_id: 3, nombre: 'Preforma 1 Lt', cantidad: 500 },
      { articulo_id: 7, nombre: 'Tapa 1 Lt', cantidad: 500 }
    ])
  }, extra);
}

beforeEach(() => {
  limpia();
  // Silencia los console.error de los caminos que probamos a proposito.
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('A1. Registrar produccion exige la linea en marcha', () => {

  test('una linea en PARADO responde 409 y no escribe el reporte', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [{ estado: 'PARADO' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/produccion/reporte', {
      body: { fecha_produccion: '2026-10-05', presentacion: 'Aceite de Soya Belini 1 Lt', cantidad_cajas: 500 }
    });

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.mensaje).toMatch(/línea de envasado está PARADO/i);
    // Lo importante: no se registró nada.
    expect(sqlDe('INSERT INTO reportes_produccion')).toHaveLength(0);
    expect(sqlDe('INSERT INTO producto_terminado')).toHaveLength(0);
    expect(sqlDe('COMMIT')).toHaveLength(0);
    expect(sqlDe('ROLLBACK').length).toBeGreaterThan(0);
  });

  test('el mensaje de 409 dice qué línea está parada y qué hacer', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [{ estado: 'PARADO' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/produccion/reporte', {
      body: { presentacion: 'Aceite de Soya Belini 1 Lt', cantidad_cajas: 500 }
    });

    expect(res.cuerpo.mensaje).toMatch(/envasado/);
    expect(res.cuerpo.mensaje).toMatch(/marcha/i);
  });

  test('una linea EN MARCHA si pasa el control y sigue registering', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [{ estado: 'EN MARCHA' }], rowCount: 1 };
      if (/FROM recetas|receta_insumos|FROM inventario WHERE lower\(nombre\)/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/produccion/reporte', {
      body: { presentacion: 'Aceite de Soya Belini 1 Lt', cantidad_cajas: 500 }
    });

    // No debe ser el 409 de la linea: si la dejo pasar, el fallo posterior (receta)
    // es otro y asi se distingue.
    expect(res.cuerpo.mensaje || '').not.toMatch(/línea de envasado está PARADO/i);
    // Y si llego a leer la receta, la consulta se hizo.
    expect(mockQuery.mock.calls.length).toBeGreaterThan(2);
  });

  test('un area sin fila en estado_lineas no bloquea (faltante, no PARADO)', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/produccion/reporte', {
      body: { presentacion: 'Aceite de Soya Belini 1 Lt', cantidad_cajas: 500 }
    });

    expect(res.cuerpo.mensaje || '').not.toMatch(/línea de envasado está PARADO/i);
    // Y no se quedo en el control de linea: following con la receta.
    expect(sqlDe('FROM recetas').length + sqlDe('lower(nombre)').length).toBeGreaterThan(0);
  });

  test('soplado tambien exige su linea en marcha', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM estado_lineas/.test(sql)) return { rows: [{ estado: 'PARADO' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/soplado/registrar', {
      body: {
        preforma_nombre: 'Preforma Belini 1 Lt',
        botella_tipo: 'soplado_belini_1lt',
        cantidad_producida: 500
      }
    });

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.mensaje).toMatch(/línea de soplado está PARADO/i);
    expect(sqlDe('INSERT INTO reportes_soplado')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('M2. La cantidad de cajas tiene que ser un entero', () => {

  test('un decimal devuelve 400 y no intenta escribir', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [{ estado: 'EN MARCHA' }], rowCount: 1 }));

    const res = await invocar('post', '/api/produccion/reporte', {
      body: { presentacion: 'Aceite de Soya Belini 1 Lt', cantidad_cajas: 10.7 }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/entero/i);
    expect(sqlDe('INSERT INTO reportes_produccion')).toHaveLength(0);
  });

  test('cero y negativo tambien se rechazan', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [{ estado: 'EN MARCHA' }], rowCount: 1 }));

    for (const cantidad of [0, -5]) {
      limpia();
      const res = await invocar('post', '/api/produccion/reporte', {
        body: { presentacion: 'Aceite de Soya Belini 1 Lt', cantidad_cajas: cantidad }
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------

describe('C2. El reporte guarda la clave del producto que se produjo', () => {

  test('el INSERT del reporte guarda producto_key como columna y como valor', () => {
    // Se lee el SQL real de la ruta porque ejercitar el camino feliz de
    // /api/produccion/reporte exige montar todo el motor de recetas, y lo que
    // importa aqui es que la columna no se pierda del INSERT: si alguien la
    // quita de la lista de columnas, el reporte se guardaria sin clave y al
    // borrarlo volverian los insumos pero no las cajas.
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const sentencia = fuente.match(/INSERT INTO reportes_produccion \(([^)]*)\)/);
    expect(sentencia).toBeTruthy();
    expect(sentencia[1]).toMatch(/producto_key/);

    // Y que se rellene con la clave resuelta, no con un literal.
    const paso = fuente.slice(fuente.indexOf('INSERT INTO reportes_produccion'));
    expect(paso.slice(0, 400)).toMatch(/desglose_insumos, producto_key\)/);
    expect(paso.slice(0, 400)).toMatch(/observaciones \|\| '', usuario \|\| 'envasado_user', desgloseJson, producto_tipo\]/);
  });

  test('la migracion que crea la columna existe y es la que la registra', () => {
    const ruta = path.join(__dirname, '..', 'migrations', '1790900001000_producto-key-en-reportes.mjs');
    expect(fs.existsSync(ruta)).toBe(true);
    const fuente = fs.readFileSync(ruta, 'utf8');
    expect(fuente).toMatch(/producto_key/);
    expect(fuente).toMatch(/idx_reportes_prod_key/);
  });

  test('al borrar manda la clave guardada, sin re-resolver por el nombre de la receta', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM reportes_produccion WHERE id/.test(sql)) return { rows: [reporteGuardado()], rowCount: 1 };
      if (/SELECT id, nombre FROM inventario/.test(sql)) {
        return { rows: [{ id: 3, nombre: 'Preforma 1 Lt' }, { id: 7, nombre: 'Tapa 1 Lt' }], rowCount: 2 };
      }
      if (/FROM inventario WHERE id = ANY/.test(sql)) {
        return { rows: [
          { id: 3, nombre: 'Preforma 1 Lt', stock: 9000 },
          { id: 7, nombre: 'Tapa 1 Lt', stock: 4000 }
        ], rowCount: 2 };
      }
      if (/UPDATE inventario SET stock = stock/.test(sql)) return { rows: [{ stock: 9500 }], rowCount: 1 };
      if (/FROM producto_terminado WHERE producto_key/.test(sql)) {
        return { rows: [{ id: 1, nombre_producto: 'Aceite de Soya Belini 1 Lt', stock_cajas: 700 }], rowCount: 1 };
      }
      if (/UPDATE producto_terminado/.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO historial_inventario/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM reportes_produccion/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE inventario SET estado/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.cuerpo.success).toBe(true);
    // El UPDATE de producto terminado se hizo contra 'belini_1lt', la clave guardada.
    const updatePT = sqlDe('UPDATE producto_terminado SET stock_cajas');
    expect(updatePT).toHaveLength(1);
    expect(updatePT[0].params[1]).toBe(1);
    expect(updatePT[0].params[0]).toBe(500);

    // Y no se fue a buscar la receta por el nombre (eso es lo que rompia cuando la
    // receta se desactivaba): no hay consulta al motor de recetas.
    const buscaReceta = registro().filter(c => /FROM recetas/i.test(c.sql));
    expect(buscaReceta).toHaveLength(0);
  });

  test('un reporte viejo sin producto_key cae al camino legacy por nombre', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM reportes_produccion WHERE id/.test(sql)) {
        // producto_key NULL: anterior a la migracion.
        return { rows: [reporteGuardado({ producto_key: null })], rowCount: 1 };
      }
      if (/FROM recetas/i.test(sql)) return { rows: [{ producto_key: 'belini_1lt' }], rowCount: 1 };
      if (/SELECT id, nombre FROM inventario/.test(sql)) {
        return { rows: [{ id: 3, nombre: 'Preforma 1 Lt' }, { id: 7, nombre: 'Tapa 1 Lt' }], rowCount: 2 };
      }
      if (/FROM inventario WHERE id = ANY/.test(sql)) {
        return { rows: [
          { id: 3, nombre: 'Preforma 1 Lt', stock: 9000 },
          { id: 7, nombre: 'Tapa 1 Lt', stock: 4000 }
        ], rowCount: 2 };
      }
      if (/UPDATE inventario SET stock = stock/.test(sql)) return { rows: [{ stock: 9500 }], rowCount: 1 };
      if (/FROM producto_terminado WHERE producto_key/.test(sql)) {
        return { rows: [{ id: 1, nombre_producto: 'Aceite de Soya Belini 1 Lt', stock_cajas: 700 }], rowCount: 1 };
      }
      if (/UPDATE producto_terminado/.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO historial_inventario/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM reportes_produccion/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE inventario SET estado/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.cuerpo.success).toBe(true);
    // Si llego al UPDATE, la clave se resolvio bien: el camino legacy funciona.
    expect(sqlDe('UPDATE producto_terminado SET stock_cajas')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('C3. Borrar un reporte devuelve solo las cajas que quedan', () => {

  /** Monta el escenario de borrado con un stock de producto terminado dado. */
  function escenarioBorrado({ stockCajas, reporte = reporteGuardado(), rowCountDelete = 1 }) {
    mockQuery.mockImplementation(async (sql) => {
      // El DELETE va primero a proposito: su texto tambien contiene
      // "FROM reportes_produccion WHERE id", asi que si se comprobara despues
      // devolveria una fila y el borrado simulado nunca seria borrado.
      if (/DELETE FROM reportes_produccion/.test(sql)) return { rows: [], rowCount: rowCountDelete };
      if (/FROM reportes_produccion WHERE id/.test(sql)) return { rows: [reporte], rowCount: 1 };
      if (/SELECT id, nombre FROM inventario/.test(sql)) {
        return { rows: [{ id: 3, nombre: 'Preforma 1 Lt' }, { id: 7, nombre: 'Tapa 1 Lt' }], rowCount: 2 };
      }
      if (/FROM inventario WHERE id = ANY/.test(sql)) {
        return { rows: [
          { id: 3, nombre: 'Preforma 1 Lt', stock: 9000 },
          { id: 7, nombre: 'Tapa 1 Lt', stock: 4000 }
        ], rowCount: 2 };
      }
      if (/UPDATE inventario SET stock = stock/.test(sql)) return { rows: [{ stock: 9500 }], rowCount: 1 };
      if (/FROM producto_terminado WHERE producto_key/.test(sql)) {
        if (stockCajas === null) return { rows: [], rowCount: 0 };
        return { rows: [{ id: 1, nombre_producto: 'Aceite de Soya Belini 1 Lt', stock_cajas: stockCajas }], rowCount: 1 };
      }
      if (/UPDATE producto_terminado/.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO historial_inventario/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE inventario SET estado/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  test('si las cajas estan todas ahi, devuelve todas y sin aviso', async () => {
    escenarioBorrado({ stockCajas: 1200 });
    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.cuerpo.success).toBe(true);
    expect(res.cuerpo.aviso).toBeFalsy();
    expect(sqlDe('UPDATE producto_terminado SET stock_cajas')[0].params[0]).toBe(500);
  });

  test('si parte ya se despacho, devuelve solo lo que queda y avisa del resto', async () => {
    escenarioBorrado({ stockCajas: 120 });
    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.cuerpo.success).toBe(true);
    // Solo restituidas 120, no las 500 que pedia el reporte.
    expect(sqlDe('UPDATE producto_terminado SET stock_cajas')[0].params[0]).toBe(120);
    // Y el operador se entera de la diferencia.
    expect(res.cuerpo.aviso).toMatch(/500/);
    expect(res.cuerpo.aviso).toMatch(/120/);
    expect(res.cuerpo.aviso).toMatch(/380/);
    // El reporte si se borro: la devolucion parcial no bloquea la operacion.
    expect(sqlDe('DELETE FROM reportes_produccion')).toHaveLength(1);
    expect(sqlDe('COMMIT')).toHaveLength(1);
    expect(sqlDe('ROLLBACK')).toHaveLength(0);
  });

  test('el aviso dice que los insumos si se devolvieron completos', async () => {
    escenarioBorrado({ stockCajas: 120 });
    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    // Es importante que quede claro que los insumos no se quedaron fuera: el
    // operador no debe pensar que se perdio material.
    expect(res.cuerpo.aviso).toMatch(/insumos se devolvieron completos/i);
    // Y efectivamente se devolvieron.
    expect(sqlDe('UPDATE inventario SET stock = stock')).toHaveLength(2);
  });

  test('el historial de producto terminado anota cuantas voltouron y cuantas no', async () => {
    escenarioBorrado({ stockCajas: 120 });
    await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    const ref = sqlDe('INSERT INTO historial_inventario')
      .find(c => /ya despachadas/.test(String(c.params[10] || '')));
    expect(ref).toBeTruthy();
    expect(String(ref.params[10])).toMatch(/120 de 500/);
  });

  test('si ya no queda ninguna caja, no se toca producto_terminado y no hay error', async () => {
    // Este es el fallo que existed: la resta reventaba contra el CHECK y el
    // ROLLBACK arrastraba la devolucion de insumos, dejando el reporte imborrable.
    escenarioBorrado({ stockCajas: 0 });
    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    expect(sqlDe('UPDATE producto_terminado SET stock_cajas')).toHaveLength(0);
    // Los insumos se devolvieron igual y el reporte se borro.
    expect(sqlDe('UPDATE inventario SET stock = stock')).toHaveLength(2);
    expect(sqlDe('DELETE FROM reportes_produccion')).toHaveLength(1);
    expect(sqlDe('ROLLBACK')).toHaveLength(0);
  });

  test('el aviso explica el caso de cero cajas disponibles', async () => {
    escenarioBorrado({ stockCajas: 0 });
    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.cuerpo.aviso).toMatch(/0/);
    expect(res.cuerpo.aviso).toMatch(/500/);
  });

  test('un DELETE que no borra ninguna fila revierte, no responde exito', async () => {
    // Si otro operador borro el reporte entre la lectura y el DELETE, la fila ya
    // no existe. Decir "eliminado" seria mentira y el operador creeria que el
    // stock se devolvio.
    escenarioBorrado({ stockCajas: 1200, rowCountDelete: 0 });
    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.cuerpo.success).toBeFalsy();
    expect(sqlDe('COMMIT')).toHaveLength(0);
    expect(sqlDe('ROLLBACK').length).toBeGreaterThan(0);
  });

  test('un reporte que ya no existe responde 404 sin tocar inventario', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM reportes_produccion WHERE id/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(res.statusCode).toBe(404);
    expect(sqlDe('UPDATE inventario SET stock = stock')).toHaveLength(0);
  });

  test('el reporte se bloquea con FOR UPDATE antes de calcular la devolucion', async () => {
    escenarioBorrado({ stockCajas: 1200 });
    await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    // Sin el lock, dos borrados simultaneos leen la misma fila, devuelven los
    // insumos dos veces y restan las cajas dos veces.
    expect(sqlDe('FROM reportes_produccion WHERE id = $1 FOR UPDATE')).toHaveLength(1);
  });

  test('producto terminado tambien se bloquea antes de restar', async () => {
    escenarioBorrado({ stockCajas: 1200 });
    await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });

    expect(sqlDe('FROM producto_terminado WHERE producto_key = $1 FOR UPDATE')).toHaveLength(1);
  });

  test('el cliente siempre se devuelve al pool', async () => {
    escenarioBorrado({ stockCajas: 0 });
    await invocar('post', '/api/produccion/eliminar', { body: { reporte_id: 9 } });
    expect(mockRelease).toHaveBeenCalled();
  });
});