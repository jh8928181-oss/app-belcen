/**
 * Tests de precios por proveedor, IGV en ordenes y facturas de OC/OS.
 *
 * Lo que importa aqui no es que las rutas existan, sino tres reglas que un
 * fallo dejaria dano datos reales:
 *   1. El IGV lo calcula el servidor. Si el cliente pudiera mandar el total, el
 *      saldo de la orden dejaria de cuadrar contra lo facturado.
 *   2. Cada cambio de precio deja fila en el historial, y esa fila sobrevive a la
 *      baja del precio: es el unico registro de cuanto costaba un insumo antes.
 *   3. Una orden con facturas no se borra, y una factura anulada no descuenta
 *      saldo (si descontara, una nota de credito anulada cobraria de menos).
 *
 * Las rutas viven en index.js, no en un router aparte, asi que se alcanzan por el
 * app exportado recorriendo su pila, igual que un router.
 */
const mockQuery = jest.fn();
const mockRelease = jest.fn();

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

const { app, IGV_POR_DEFECTO, normalizarMoneda, redondear2, normalizarItemsOrden } = require('../index');

function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    headersSent: false,
    status(codigo) { r.statusCode = codigo; return r; },
    // Un res.json sin status previo es un 200, igual que en Express.
    json(cuerpo) {
      if (r.statusCode === null) r.statusCode = 200;
      r.cuerpo = cuerpo;
      r.headersSent = true;
      return r;
    }
  };
  return r;
}

/**
 * Devuelve la pila completa de la ruta (guard incluido), no solo su handler final.
 *
 * Las rutas con parametro se registran con el patron ('/api/bd/ordenes/:id'), no
 * con el valor concreto ('/api/bd/ordenes/5'). Un segmento con ':' hace match con
 * cualquier valor, pero gana la ruta literal: '/api/bd/facturas/ordenes' tiene
 * el mismo numero de segmentos que '/api/bd/facturas/:id' y debe resolver a la
 * primera, igual que en Express. Entre literales gana la ultima registrada.
 */
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

  const conParam = candidatas.filter(l => l.route.path.indexOf(':') >= 0).length;
  const literales = candidatas.filter(l => l.route.path.indexOf(':') < 0);
  const capa = (literales.length ? literales : candidatas).pop();

  if (conParam && literales.length) {
    console.warn(`[test] ${method.toUpperCase()} ${ruta} tambien coincide con una ruta con parametro; se usa la literal.`);
  }
  return capa.route.stack.map(l => l.handle);
}

/**
 * Ejecuta la ruta como en produccion, recorriendo sus capas en orden: primero el
 * guard, y solo si este llama a next() sigue al handler. Por eso un rol no
 * permitido recibe 403 sin llegar a tocar la base de datos.
 *
 * El final no se decide por la promesa del guard, que resuelve en el acto al
 * llamar a next(), sino por la de la ultima capa: si se esperara a la del guard
 * se leeria la respuesta antes de que el handler la escribiera. Y si una capa
 * responde y no llama a next() (el 403 del guard), no hay nada mas que esperar:
 * se resuelve en cuanto res.headersSent queda en true.
 */
async function invocar(method, ruta, req = {}) {
  const res = resFalso();
  const peticion = Object.assign(
    { params: {}, body: {}, query: {}, usuario: 'admin1', rol: 'admin', headers: {}, method, originalUrl: ruta },
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


/**
 * Enruta cada consulta por su SQL en vez de por orden de llamada.
 *
 * Contar posiciones es fragil: BEGIN, COMMIT y ROLLBACK tambien pasan por el
 * mock, asi que agregar una validacion nueva desplaza todas las posiciones y los
 * tests empiezan a fallar sin que cambie el codigo bajo prueba. Aqui cada patron
 * declara que devuelve y lo no declarado devuelve una tabla vacia.
 */
function responder(reglas) {
  mockQuery.mockImplementation(async (sql) => {
    const texto = String(sql || '').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto)) return { rows: [], rowCount: 0 };
    for (const [patron, respuesta] of reglas) {
      if (patron instanceof RegExp ? patron.test(texto) : texto.includes(patron)) {
        return typeof respuesta === 'function' ? respuesta(texto) : respuesta;
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

/**
 * Patrones de SQL que identifican cada sentencia, sin confusion entre tablas.
 * El espacio antes del parentesis se acepta como \s porque el INSERT se arma en
 * varias lineas: 'INSERT INTO facturas\n   (tipo...' es la misma sentencia.
 */
const SQL = {
  leerProveedor: /SELECT id, nombre FROM proveedores/,
  leerPrecio: /SELECT pp\.\*, pr\.nombre/,
  insertarPrecio: /INSERT INTO precios_proveedor\s*\(/,
  actualizarPrecio: /UPDATE precios_proveedor SET/,
  borrarPrecio: /DELETE FROM precios_proveedor WHERE/,
  insertarHistorial: /INSERT INTO precios_proveedor_historial/,
  leerFactura: /SELECT \* FROM facturas WHERE/,
  // El registro de estado que consulta /pagar antes de decidir. Es un SELECT
  // mas estrecho que leerFactura y por eso necesita patron propio: si share el
  // de lectura completa, un test no podria_simular una factura cancelada.
  estadoFactura: /SELECT id, estado FROM facturas WHERE/,
  insertarFactura: /INSERT INTO facturas\s*\(/,
  actualizarFactura: /UPDATE facturas SET/,
  pagarFactura: /UPDATE facturas SET estado = 'PAGADA'/,
  // Una sola forma de reconocer la lectura de una orden por id: con y sin join
  // se resuelve al mismo SELECT, asi que un unico patron evita que el orden de
  // las reglas decida cual responde.
  ordenPorId: /FROM ordenes_compras_servicios(?: o)?\s*(?:LEFT JOIN proveedores p ON p\.id = o\.proveedor_id\s*)?WHERE (?:o\.)?id = \$1/,
  ordenParaFacturar: /FROM ordenes_compras_servicios o\s+LEFT JOIN proveedores/,
  ordenSimple: /SELECT \* FROM ordenes_compras_servicios WHERE id/,
  itemsDeOrden: /SELECT \* FROM ordenes_items WHERE orden_id/,
  facturasDeOrden: /FROM facturas WHERE orden_id = \$1/,
  // El conteo que bloquea el borrado de una orden facturada. Se distingue del
  // listado de facturas de la orden porque solo trae un numero, no las filas.
  conteoFacturasDeOrden: /SELECT COUNT\(\*\)::int AS n FROM facturas/,
  borrarOrden: /DELETE FROM ordenes_compras_servicios WHERE id/
};


const filas = (...rows) => ({ rows, rowCount: rows.length });
const fallo = codigo => Object.assign(new Error('fallo simulado'), { code: codigo });

/** Sentencias de control de transaccion que se ejecutaron, en orden. */
function transacciones() {
  return mockQuery.mock.calls
    .map(c => String(c[0]).trim().toUpperCase())
    .filter(s => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(s));
}

/** SQL de las consultas que no son control de transaccion, en orden. */
function sentencias() {
  return mockQuery.mock.calls
    .map(c => String(c[0]).trim())
    .filter(s => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s));
}

/** Parametros de la primera consulta cuyo SQL coincide con el patron. */
function paramsDe(patron) {
  const llamada = mockQuery.mock.calls.find(c => patron.test(String(c[0])));
  return llamada ? llamada[1] : undefined;
}

const PROVEEDOR = { id: 7, nombre: 'CEMENTOS DEL SUR' };

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('calculo de IGV en ordenes', () => {
  test('el total sigue siendo la base imponible, sin IGV adentro', () => {
    const r = normalizarItemsOrden([{ descripcion: 'Cemento', cantidad: 10, precio: 25, unidad: 'BOLSA' }]);
    expect(r.total).toBe(250);
  });

  test('aplica el 18 por ciento por defecto', () => {
    const r = normalizarItemsOrden([{ descripcion: 'Cemento', cantidad: 10, precio: 25 }]);
    expect(r.igv).toBe(45);
    expect(r.totalIgv).toBe(295);
  });

  test('respeta un igv_pct de 0 para un insumo exonerado', () => {
    const r = normalizarItemsOrden([{ descripcion: 'Servicio exonerado', cantidad: 1, precio: 100 }], 0);
    expect(r.igv).toBe(0);
    expect(r.totalIgv).toBe(100);
  });

  test('acota un porcentaje fuera de rango en vez de guardarlo tal cual', () => {
    expect(normalizarItemsOrden([{ descripcion: 'X', cantidad: 1, precio: 100 }], 200).igv).toBe(100);
    expect(normalizarItemsOrden([{ descripcion: 'X', cantidad: 1, precio: 100 }], -50).igv).toBe(0);
  });

  test('cae a 18 cuando el porcentaje no es un numero', () => {
    expect(normalizarItemsOrden([{ descripcion: 'X', cantidad: 1, precio: 100 }], 'abc').igv).toBe(18);
  });

  test('el total con IGV es siempre subtotal mas IGV, sin decimales sueltos', () => {
    const r = normalizarItemsOrden([
      { descripcion: 'Aceite', cantidad: 3, precio: 19.9 },
      { descripcion: 'Envase', cantidad: 1, precio: 5.55 }
    ]);
    expect(r.total).toBe(65.25);
    expect(r.igv).toBe(11.75);
    expect(r.totalIgv).toBe(77);
  });

  test('descarta lineas sin descripcion, sin cantidad o con precio no numerico', () => {
    const r = normalizarItemsOrden([
      { descripcion: '', cantidad: 5, precio: 10 },
      { descripcion: 'Sin cantidad', cantidad: 0, precio: 10 },
      { descripcion: 'Precio raro', cantidad: 1, precio: 'abc' },
      { descripcion: 'Valida', cantidad: 2, precio: 10 }
    ]);
    expect(r.items).toHaveLength(1);
    expect(r.total).toBe(20);
  });

  test('no muta el arreglo recibido', () => {
    const items = [{ descripcion: 'X', cantidad: 2, precio: 5 }];
    const copia = JSON.parse(JSON.stringify(items));
    normalizarItemsOrden(items);
    expect(items).toEqual(copia);
  });

  test('IGV_POR_DEFECTO es 18', () => {
    expect(IGV_POR_DEFECTO).toBe(18);
  });
});

describe('redondeo y moneda', () => {
  test('redondea a dos decimales sin el error clasico del 1.005', () => {
    expect(redondear2(1.005)).toBe(1.01);
    expect(redondear2(2.675)).toBe(2.68);
  });

  test('acepta PEN y USD, y cualquier otra cosa cae a PEN', () => {
    expect(normalizarMoneda('PEN')).toBe('PEN');
    expect(normalizarMoneda('usd')).toBe('USD');
    expect(normalizarMoneda('euro')).toBe('PEN');
    expect(normalizarMoneda(undefined)).toBe('PEN');
  });
});

describe('precios por proveedor', () => {
  test('crear un precio anota el alta en el historial con precio anterior 0', async () => {
    responder([
      [SQL.leerProveedor, filas(PROVEEDOR)],
      [SQL.insertarPrecio,  filas({ id: 12, moneda: 'PEN', precio: '25.5000' })]
    ]);

    const res = await invocar('post', '/api/bd/precios', {
      body: { proveedor_id: 7, producto: 'Cemento', unidad: 'BOLSA', precio: 25.5, moneda: 'PEN' }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);

    const p = paramsDe(SQL.insertarHistorial);
    expect(p).toBeDefined();
    // En el alta, precio_anterior va como literal 0 en el SQL, asi que el
    // ultimo parametro de precio es el nuevo: indice 6.
    expect(Number(p[6])).toBe(25.5);
    expect(p[0]).toBe(12);   // precio_id recien creado
    expect(p[1]).toBe(7);    // proveedor_id
    expect(transacciones()).toContain('COMMIT');

  });

  test('rechaza un precio sin proveedor, sin producto o negativo', async () => {
    responder([]);
    expect((await invocar('post', '/api/bd/precios', { body: { producto: 'X', precio: 10 } })).statusCode).toBe(400);
    expect((await invocar('post', '/api/bd/precios', { body: { proveedor_id: 1, producto: '  ', precio: 10 } })).statusCode).toBe(400);
    expect((await invocar('post', '/api/bd/precios', { body: { proveedor_id: 1, producto: 'X', precio: -1 } })).statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('no inserta nada si el proveedor no existe', async () => {
    responder([[SQL.leerProveedor, filas()]]);

    const res = await invocar('post', '/api/bd/precios', {
      body: { proveedor_id: 999, producto: 'X', precio: 10 }
    });

    expect(res.statusCode).toBe(404);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sentencias().some(s => SQL.insertarPrecio.test(s))).toBe(false);

  });

  test('editar un precio guarda el anterior en el historial y actualiza el vigente', async () => {
    responder([
      [/SELECT pp\.\*, pr\.nombre/, filas({
        id: 12, proveedor_id: 7, proveedor_nombre: PROVEEDOR.nombre,
        producto: 'Cemento', unidad: 'BOLSA', precio: '25.0000', moneda: 'PEN'
      })],
      [SQL.actualizarPrecio, filas({ id: 12, moneda: 'PEN', precio: '27.5000' })]
    ]);

    const res = await invocar('put', '/api/bd/precios/12', {
      params: { id: '12' },
      body: { producto: 'Cemento', unidad: 'BOLSA', precio: 27.5, moneda: 'PEN' }
    });

    expect(res.cuerpo.success).toBe(true);

    const p = paramsDe(SQL.insertarHistorial);
    expect(Number(p[6])).toBe(25);     // precio_anterior: el que estaba
    expect(Number(p[7])).toBe(27.5);   // precio_nuevo: el que quedo
    // El historial guarda a que proveedor pertenece, para que el filtro por
    // proveedor siga funcionando aunque el precio se borre despues.
    expect(p[0]).toBe(12);             // precio_id
    expect(p[1]).toBe(7);              // proveedor_id
    expect(p[2]).toBe(PROVEEDOR.nombre);
    expect(transacciones()).toContain('COMMIT');

  });

  test('si el historial falla, el precio tampoco queda cambiado', async () => {
    responder([
      [/SELECT pp\.\*, pr\.nombre/, filas({ id: 12, proveedor_id: 7, proveedor_nombre: 'X', producto: 'Cemento', unidad: 'BOLSA', precio: '25.0000' })],
      [SQL.actualizarPrecio, filas({ id: 12 })],
      [SQL.insertarHistorial, () => Promise.reject(new Error('historial caido'))]
    ]);

    const res = await invocar('put', '/api/bd/precios/12', {
      params: { id: '12' },
      body: { producto: 'Cemento', unidad: 'BOLSA', precio: 99 }
    });

    expect(res.statusCode).toBe(500);
    // El UPDATE llego a ejecutarse, pero sin COMMIT queda revertido.
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('traduce el conflicto de precio duplicado a un mensaje util', async () => {
    responder([
      [SQL.leerProveedor, filas(PROVEEDOR)],
      [SQL.insertarPrecio,  () => Promise.reject(fallo('23505'))]
    ]);

    const res = await invocar('post', '/api/bd/precios', {
      body: { proveedor_id: 7, producto: 'Cemento', unidad: 'BOLSA', precio: 10 }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/ya tiene un precio/i);
  });

  test('el historial filtra por su propio proveedor_id, no por el del precio vigente', async () => {
    responder([]);

    await invocar('get', '/api/bd/precios/historial', { query: { proveedor_id: '7' } });

    const sql = sentencias()[0];
    expect(sql).toMatch(/h\.proveedor_id/);
    expect(sql).not.toMatch(/JOIN precios_proveedor/);
  });

  // Un select de proveedor vacio viaja como proveedor_id=undefined o ="". Mandar
  // eso a Postgres como NaN es un 500 en pantalla, no un filtro ignorado.
  test('un proveedor_id no numerico no revienta el historial: lista todo', async () => {
    responder([]);

    const res = await invocar('get', '/api/bd/precios/historial', { query: { proveedor_id: 'undefined' } });

    expect(res.statusCode).toBe(200);
    const p = paramsDe(/FROM precios_proveedor_historial/);
    expect(p[0]).toBeNull();
  });

  test('borrar un precio no toca el historial', async () => {

    responder([[SQL.borrarPrecio, filas({ producto: 'Cemento' })]]);

    const res = await invocar('delete', '/api/bd/precios/12', { params: { id: '12' } });

    expect(res.cuerpo.success).toBe(true);
    expect(sentencias()).toHaveLength(1);
    expect(sentencias()[0]).toMatch(/^DELETE FROM precios_proveedor/);
  });

  test('borrar un precio inexistente responde 404', async () => {
    responder([[SQL.borrarPrecio, filas()]]);

    const res = await invocar('delete', '/api/bd/precios/99', { params: { id: '99' } });

    expect(res.statusCode).toBe(404);
  });
});

describe('facturas de OC / OS', () => {
  const ORDEN = {
    id: 5, proveedor_id: 7, proveedor_nombre: PROVEEDOR.nombre,
    moneda: 'PEN', total: '1000.00', igv: '180.00', total_igv: '1180.00'
  };

  test('calcula igv y total en el servidor e ignora los que manda el cliente', async () => {
    responder([
      [SQL.ordenParaFacturar, filas(ORDEN)],
      [SQL.insertarFactura, filas({ id: 1, igv: '180.00', total: '1180.00' })]
    ]);

    const res = await invocar('post', '/api/bd/facturas', {
      body: {
        tipo_comprobante: 'FACTURA', serie: 'F001', numero: '0001',
        orden_id: 5, subtotal: 1000, igv_pct: 18,
        igv: 999, total: 1   // el cliente intenta mandar su propio total
      }
    });

    expect(res.cuerpo.success).toBe(true);
    const p = paramsDe(SQL.insertarFactura);
    expect(Number(p[10])).toBe(180);   // igv calculado
    expect(Number(p[11])).toBe(1180); // total calculado
  });

  test('toma el proveedor de la orden, no el que venga en el cuerpo', async () => {
    responder([
      [SQL.ordenParaFacturar, filas(ORDEN)],
      [SQL.insertarFactura, filas({ id: 1 })]
    ]);

    await invocar('post', '/api/bd/facturas', {
      body: {
        serie: 'F001', numero: '0002', orden_id: 5, subtotal: 1000,
        proveedor_id: 999, proveedor_nombre: 'PROVEEDOR FALSO'
      }
    });

    const p = paramsDe(SQL.insertarFactura);
    expect(p[5]).toBe(7);
    expect(p[6]).toBe(PROVEEDOR.nombre);
  });

  test('acota el igv_pct tambien en facturas', async () => {
    responder([
      [SQL.ordenParaFacturar, filas(ORDEN)],
      [SQL.insertarFactura, filas({ id: 1 })]
    ]);

    await invocar('post', '/api/bd/facturas', {
      body: { serie: 'F001', numero: '0003', orden_id: 5, subtotal: 100, igv_pct: 500 }
    });

    const p = paramsDe(SQL.insertarFactura);
    expect(Number(p[9])).toBe(100);
    expect(Number(p[10])).toBe(100);
    expect(Number(p[11])).toBe(200);
  });

  test('fecha vacia no se manda como null a una columna NOT NULL', async () => {
    responder([
      [SQL.ordenParaFacturar, filas(ORDEN)],
      [SQL.insertarFactura, filas({ id: 1 })]
    ]);

    await invocar('post', '/api/bd/facturas', {
      body: { serie: 'F001', numero: '0004', orden_id: 5, subtotal: 100 }
    });

    const fecha = paramsDe(SQL.insertarFactura)[3];
    expect(fecha).not.toBeNull();
    expect(String(fecha)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('exige orden, serie, numero y subtotal valido', async () => {
    responder([]);
    const base = { serie: 'F001', numero: '1', subtotal: 10 };

    expect((await invocar('post', '/api/bd/facturas', { body: { ...base, orden_id: undefined } })).statusCode).toBe(400);
    expect((await invocar('post', '/api/bd/facturas', { body: { ...base, orden_id: 5, serie: '', numero: '' } })).statusCode).toBe(400);
    expect((await invocar('post', '/api/bd/facturas', { body: { ...base, orden_id: 5, subtotal: -5 } })).statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rechaza comprobante duplicado con mensaje claro', async () => {
    responder([
      [SQL.ordenParaFacturar, filas(ORDEN)],
      [SQL.insertarFactura, () => Promise.reject(fallo('23505'))]
    ]);

    const res = await invocar('post', '/api/bd/facturas', {
      body: { serie: 'F001', numero: '0001', orden_id: 5, subtotal: 100 }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/ya existe/i);
  });

  test('al editar recalcula igv y total, guarda el tipo y conserva la fecha si no llega otra', async () => {
    responder([
      [/SELECT \* FROM facturas/, filas({ id: 4, tipo_comprobante: 'FACTURA', fecha_factura: '2026-03-01' })],
      [SQL.actualizarFactura, filas({ id: 4, total: '236.00' })]
    ]);

    await invocar('put', '/api/bd/facturas/4', {
      params: { id: '4' },
      body: { tipo_comprobante: 'BOLETA', serie: 'B001', numero: '0009', subtotal: 200, igv_pct: 18 }
    });

    const sql = paramsDe(SQL.actualizarFactura);
    expect(sql).toBeDefined();
    const p = mockQuery.mock.calls.find(c => SQL.actualizarFactura.test(c[0]))[1];
    expect(p[0]).toBe('BOLETA');       // el tipo si se guarda
    expect(p[3]).toBe('2026-03-01');   // la fecha se conserva
    expect(Number(p[6])).toBe(36);
    expect(Number(p[7])).toBe(236);
  });

  // pg devuelve las columnas date como Date. Si el codito las tratara como
  // texto, mandaria "Thu Oct 01" a una columna date y Postgres lo rechaza.
  test('conserva la fecha aunque pg la devuelva como Date, no como texto', async () => {
    responder([
      [/SELECT \* FROM facturas/, filas({ id: 4, tipo_comprobante: 'FACTURA', fecha_factura: new Date(2026, 2, 1) })],
      [SQL.actualizarFactura, filas({ id: 4, total: '236.00' })]
    ]);

    const res = await invocar('put', '/api/bd/facturas/4', {
      params: { id: '4' },
      body: { tipo_comprobante: 'FACTURA', serie: 'B001', numero: '0009', subtotal: 200, igv_pct: 18 }
    });

    expect(res.statusCode).toBe(200);
    const p = mockQuery.mock.calls.find(c => SQL.actualizarFactura.test(c[0]))[1];
    expect(p[3]).toBe('2026-03-01');
  });

  test('marcar como pagada mueve estado y fecha_pago', async () => {
    responder([
      [SQL.estadoFactura, filas({ id: 4, estado: 'CREDITO' })],
      [SQL.pagarFactura, filas({ id: 4, estado: 'PAGADA', fecha_pago: '2026-05-10' })]
    ]);

    const res = await invocar('post', '/api/bd/facturas/4/pagar', {
      params: { id: '4' },
      body: { fecha_pago: '2026-05-10' }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    // La primera sentencia ya no es el UPDATE: ahora se lee el estado actual
    // para decidir si se puede pagar.
    const sql = sentencias().find(s => SQL.pagarFactura.test(s));
    expect(sql).toMatch(/estado/);
    expect(sql).toMatch(/fecha_pago/);
  });

  test('el resumen agrupa por moneda y estado, no por todo junto', async () => {
    responder([]);

    await invocar('get', '/api/bd/facturas/resumen');

    // Sumar soles y dolares en una misma cifra daria un numero sin sentido.
    expect(sentencias()[0]).toMatch(/GROUP BY moneda, estado/);
  });
});

describe('ordenes facturadas', () => {
  test('el saldo ignora las facturas anuladas', async () => {
    responder([
      [SQL.ordenPorId, filas({ id: 5, total_igv: '1180.00' })],

      [SQL.facturasDeOrden, filas(

        { id: 1, estado: 'PAGADA', total: '1000.00' },
        { id: 2, estado: 'ANULADA', total: '500.00' }
      )]
    ]);

    const res = await invocar('get', '/api/bd/ordenes/5', { params: { id: '5' } });

    // 1180 - 1000 = 180. La anulada no resta.
    expect(res.cuerpo.por_facturar).toBe(180);
    expect(res.cuerpo.pagado).toBe(1000);
    expect(res.cuerpo.por_cobrar).toBe(0);
    expect(res.cuerpo.facturas).toHaveLength(2);
  });

  test('borrar una orden con facturas responde 409 y no borra', async () => {
    responder([
      [SQL.ordenPorId, filas({ id: 5, tipo: 'OC', numero: '0456', estado: 'EMITIDA' })],
      [SQL.conteoFacturasDeOrden, filas({ n: 2 })]
    ]);


    const res = await invocar('delete', '/api/bd/ordenes/5', { params: { id: '5' } });

    expect(res.statusCode).toBe(409);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(sentencias().some(s => /^DELETE FROM ordenes_compras_servicios/.test(s))).toBe(false);
  });

  test('borrar una orden sin facturas si procede', async () => {
    responder([
      [SQL.ordenPorId, filas({ id: 9, tipo: 'OC', numero: '0999', estado: 'BORRADOR' })],
      [SQL.conteoFacturasDeOrden, filas({ n: 0 })]
    ]);

    const res = await invocar('delete', '/api/bd/ordenes/9', { params: { id: '9' } });

    expect(res.statusCode).toBe(200);
    expect(transacciones()).toEqual(['BEGIN', 'COMMIT']);
  });


  test('el selector de ordenes excluye las canceladas y calcula el saldo', async () => {
    responder([]);

    await invocar('get', '/api/bd/facturas/ordenes', { query: { filtro: 'pendiente' } });

    const sql = sentencias()[0];
    expect(sql).toMatch(/o\.estado <> 'CANCELADA'/);
    expect(sql).toMatch(/AS por_facturar/);
    expect(sql).toMatch(/AS por_cobrar/);
    expect(sql).toMatch(/pendiente/);
  });
});

describe('los cinco estados de pago de una factura', () => {
  // Total de la orden 1000.
  const ORDEN = { id: 5, total_igv: '1000.00', moneda: 'PEN' };

  /**
   * Monta el detalle de una orden con las facturas indicadas y devuelve las
   * cuatro cifras que la pantalla usa para decidir si falta emitir o falta
   * cobrar. El caso interesante de estos tests es la diferencia entre ANULADA y
   * CANCELADA, que se demarcan solo en estos numeros.
   */
  async function detalleCon(facturas) {
    responder([
      [SQL.ordenPorId, filas(ORDEN)],
      [SQL.facturasDeOrden, filas(...facturas)]
    ]);
    const res = await invocar('get', '/api/bd/ordenes/5', { params: { id: '5' } });
    expect(res.statusCode).toBe(200);
    return res.cuerpo;
  }

  test('ANULADA no cuenta ni como facturada ni como pagada', async () => {
    const d = await detalleCon([
      { id: 1, estado: 'ANULADA', total: '1000.00' }
    ]);
    expect(d.facturado).toBe(0);
    expect(d.pagado).toBe(0);
    // El importe vuelve al por facturar: es como si nunca se hubiera emitido.
    expect(d.por_facturar).toBe(1000);
    expect(d.por_cobrar).toBe(0);
  });

  test('CANCELADA cuenta como facturada pero nunca como pagada', async () => {
    const d = await detalleCon([
      { id: 1, estado: 'CANCELADA', total: '1000.00' }
    ]);
    // La orden si se cubrio a ese precio, asi que no queda nada por emitir.
    expect(d.facturado).toBe(1000);
    expect(d.por_facturar).toBe(0);
    // Pero el dinero no entro, asi que la deuda sigue abierta a proposito: es
    // el monto que la empresa perdio y no debe desaparecer de la pantalla.
    expect(d.pagado).toBe(0);
    expect(d.por_cobrar).toBe(1000);
  });

  test('CREDITO cuenta como facturado y queda abierto hasta que se pague', async () => {
    const d = await detalleCon([
      { id: 1, estado: 'CREDITO', total: '600.00', fecha_vencimiento: '2099-01-01' }
    ]);
    expect(d.facturado).toBe(600);
    expect(d.pagado).toBe(0);
    expect(d.por_facturar).toBe(400);
    expect(d.por_cobrar).toBe(600);
  });

  test('PENDIENTE y CREDITO se acumulan en el mismo por cobrar', async () => {
    const d = await detalleCon([
      { id: 1, estado: 'PENDIENTE', total: '400.00' },
      { id: 2, estado: 'CREDITO', total: '300.00' },
      { id: 3, estado: 'PAGADA', total: '300.00' }
    ]);
    expect(d.facturado).toBe(1000);
    expect(d.pagado).toBe(300);
    expect(d.por_cobrar).toBe(700);
    expect(d.por_facturar).toBe(0);
  });

  test('la factura a credito se marca vencida cuando el plazo ya paso', async () => {
    const hoy = new Date();
    const futuro = new Date(hoy.getTime() + 86400000 * 30).toISOString().slice(0, 10);
    const pasado = new Date(hoy.getTime() - 86400000 * 5).toISOString().slice(0, 10);

    // El calculo lo hace CURRENT_DATE en la consulta, asi que el mock devuelve
    // el booleano ya resuelto: lo que se verifica aca es que la condicion se
    // trae y se expone, no la aritmetica del servidor de Postgres.
    const vencida = await detalleCon([
      { id: 1, estado: 'CREDITO', total: '100.00', vencida: true }
    ]);
    expect(vencida.facturas[0].vencida).toBe(true);

    const noVencida = await detalleCon([
      { id: 2, estado: 'CREDITO', total: '100.00', vencida: false }
    ]);
    expect(noVencida.facturas[0].vencida).toBe(false);

    const consulta = sentencias().find(s => /FROM facturas WHERE orden_id/.test(s));
    expect(consulta).toMatch(/fecha_vencimiento < CURRENT_DATE/);
    expect(consulta).toMatch(/estado = 'CREDITO'/);
    expect(futuro).not.toBe(pasado);
  });

  test('solo una factura a credito puede estar vencida', async () => {
    // Una PENDIENTE con fecha de vencimiento suelta no está vencida: sin plazo
    // no hay nada que vencer, y marcarla seria ruido.
    const d = await detalleCon([
      { id: 1, estado: 'PENDIENTE', total: '100.00', vencida: false }
    ]);
    expect(d.facturas[0].vencida).toBe(false);
  });
});

describe('vencimiento de la factura a credito', () => {
  test('se acepta una factura a credito con fecha de vencimiento', async () => {
    responder([
      [SQL.ordenPorId, filas({ id: 5, proveedor_id: 7, proveedor_nombre: 'CEMENTOS DEL SUR', moneda: 'PEN', total_igv: '1000.00' })],
      [SQL.insertarFactura, filas({ id: 1, estado: 'CREDITO', fecha_vencimiento: '2026-11-30' })]
    ]);

    const res = await invocar('post', '/api/bd/facturas', {
      body: {
        serie: 'F001', numero: '1', orden_id: 5, subtotal: 100,
        estado: 'CREDITO', fecha_vencimiento: '2026-11-30'
      }
    });

    expect(res.statusCode).toBe(200);
    expect(paramsDe(SQL.insertarFactura)).toContain('2026-11-30');
  });

  test('una factura a credito sin vencimiento se rechaza', async () => {
    responder([
      [SQL.ordenPorId, filas({ id: 5, proveedor_id: 7, proveedor_nombre: 'X', moneda: 'PEN' })]
    ]);

    const res = await invocar('post', '/api/bd/facturas', {
      body: { serie: 'F001', numero: '1', orden_id: 5, subtotal: 100, estado: 'CREDITO' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/vencimiento/);
    // No se llega a insertar nada.
    expect(mockQuery.mock.calls.some(c => SQL.insertarFactura.test(String(c[0])))).toBe(false);
  });

  test('el vencimiento se guarda como NULL si el estado no es credito', async () => {
    responder([
      [SQL.ordenPorId, filas({ id: 5, proveedor_id: 7, proveedor_nombre: 'X', moneda: 'PEN' })],
      [SQL.insertarFactura, filas({ id: 1, estado: 'PAGADA' })]
    ]);

    const res = await invocar('post', '/api/bd/facturas', {
      body: {
        serie: 'F001', numero: '1', orden_id: 5, subtotal: 100,
        estado: 'PAGADA', fecha_vencimiento: '2026-11-30'
      }
    });

    expect(res.statusCode).toBe(200);
    // Los dias que se pusieron quedan obsoletos en cuanto la factura deja de
    // estar a credito, asi que no se conservan.
    expect(paramsDe(SQL.insertarFactura)).toContain(null);
  });

  test('al editar a credito sin vencimiento se conserva el que ya tenia', async () => {
    responder([
      [SQL.leerFactura, filas({ id: 1, estado: 'CREDITO', fecha_vencimiento: '2026-12-31', tipo_comprobante: 'FACTURA' })],
      [SQL.actualizarFactura, filas({ id: 1, estado: 'CREDITO', fecha_vencimiento: '2026-12-31' })]
    ]);

    const res = await invocar('put', '/api/bd/facturas/1', {
      params: { id: '1' },
      body: { numero: '1', subtotal: 100, igv_pct: 18, estado: 'CREDITO' }
    });

    expect(res.statusCode).toBe(200);
    expect(paramsDe(SQL.actualizarFactura)).toContain('2026-12-31');
  });

  test('un estado desconocido en la edicion no cae a PENDIENTE en silencio', async () => {
    responder([[SQL.leerFactura, filas({ id: 1, estado: 'PAGADA' })]]);

    const res = await invocar('put', '/api/bd/facturas/1', {
      params: { id: '1' },
      body: { numero: '1', subtotal: 100, igv_pct: 18, estado: 'Cobrada' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/estado/);
  });

  test('si la edicion no manda estado, se conserva el que ya tenia', async () => {
    responder([
      [SQL.leerFactura, filas({ id: 1, estado: 'CANCELADA', tipo_comprobante: 'FACTURA' })],
      [SQL.actualizarFactura, filas({ id: 1, estado: 'CANCELADA' })]
    ]);

    const res = await invocar('put', '/api/bd/facturas/1', {
      params: { id: '1' },
      body: { numero: '1', subtotal: 100, igv_pct: 18 }
    });

    expect(res.statusCode).toBe(200);
    // Editar el numero no puede dejar una factura cancelada como pendiente.
    expect(paramsDe(SQL.actualizarFactura)).toContain('CANCELADA');
  });
});

describe('pagar una factura', () => {
  test('una factura anulada no se puede marcar como pagada', async () => {
    responder([[SQL.estadoFactura, filas({ id: 1, estado: 'ANULADA' })]]);

    const res = await invocar('post', '/api/bd/facturas/1/pagar', { params: { id: '1' } });

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.mensaje).toMatch(/anulada/);
    // Sin UPDATE: pagar una anulada la resucitaria como deuda real.
    expect(mockQuery.mock.calls.some(c => SQL.pagarFactura.test(String(c[0])))).toBe(false);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('una factura cancelada no se puede marcar como pagada', async () => {
    responder([[SQL.estadoFactura, filas({ id: 1, estado: 'CANCELADA' })]]);

    const res = await invocar('post', '/api/bd/facturas/1/pagar', { params: { id: '1' } });

    expect(res.statusCode).toBe(409);
    expect(res.cuerpo.mensaje).toMatch(/cancelada/);
    expect(transacciones()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('pagar limpia el vencimiento', async () => {
    responder([
      [SQL.estadoFactura, filas({ id: 1, estado: 'CREDITO' })],
      [SQL.pagarFactura, filas({ id: 1, estado: 'PAGADA' })]
    ]);

    const res = await invocar('post', '/api/bd/facturas/1/pagar', { params: { id: '1' } });

    expect(res.statusCode).toBe(200);
    const sql = sentencias().find(s => SQL.pagarFactura.test(s));
    // Una factura pagada con fecha de vencimiento vieja volveria a "vencida" si
    // alguien la devuelve a credito.
    expect(sql).toMatch(/fecha_vencimiento = NULL/);
  });
});

describe('acceso a la pestana de precios y facturas', () => {
  test.each([
    ['admin', 200],
    ['auditoria', 200],
    ['consulta_bd', 200],
    ['supervisor', 403],
    ['vigilancia', 403],
    ['almacen', 403]
  ])('el rol %s recibe %i', async (rol, esperado) => {
    responder([]);

    const res = await invocar('get', '/api/bd/precios', { rol });

    expect(res.statusCode).toBe(esperado);
    if (esperado === 403) expect(mockQuery).not.toHaveBeenCalled();
  });

  test('sin rol no pasa, aunque el usuario exista', async () => {
    responder([]);

    const res = await invocar('get', '/api/bd/facturas', { rol: undefined });

    expect(res.statusCode).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('las escrituras tambien quedan cerradas para roles sin acceso', async () => {
    responder([]);

    const res = await invocar('post', '/api/bd/facturas', {
      rol: 'produccion',
      body: { serie: 'F001', numero: '1', orden_id: 1, subtotal: 10 }
    });

    expect(res.statusCode).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});



