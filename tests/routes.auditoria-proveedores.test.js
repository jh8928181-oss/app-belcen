/**
 * Ingresos de Almacén separados por proveedor: el vínculo contra el catálogo
 * de la Base de Datos General.
 *
 *   - /api/auditoria/entradas expone proveedor_id y el nombre canónico
 *     (proveedor_catalogo) de las filas de Almacén;
 *   - /api/auditoria/proveedores sirve la lista mínima del catálogo (no se
 *     reusa /api/bd/proveedores: ese exige roles de BD General y esta
 *     pantalla la abren también producción y supervisor);
 *   - /api/auditoria/vincular-proveedores reintenta el match sobre lo que
 *     quedó sin vínculo, en lote y en una transacción;
 *   - al conformar, el texto del proveedor se liga al catálogo (exacto >
 *     contenido único) y se guarda en proveedor_id; si no coincide, queda
 *     nulo y el texto se conserva.
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

jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, authMiddleware: (req, res, next) => next() };
});

const { app } = require('../index');

function resFalso() {
  const r = {
    statusCode: null, cuerpo: null, headersSent: false,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) {
      if (r.statusCode === null) r.statusCode = 200;
      r.cuerpo = cuerpo; r.headersSent = true; return r;
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
  const literales = candidatas.filter(l => l.route.path.indexOf(':') < 0);
  return (literales.length ? literales : candidatas).pop().route.stack.map(l => l.handle);
}

async function invocar(method, ruta, req = {}) {
  const res = resFalso();
  const peticion = Object.assign(
    { params: {}, body: {}, query: {}, usuario: 'admin', rol: 'admin', headers: {}, method, originalUrl: ruta },
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

const CANONICOS = [
  { id: 60, nombre: 'Etiqueta couche 90 gr x 1 lt B-1', stock: 101.53 },
  { id: 66, nombre: 'Etiqueta couche 90 gr x 1 lt Belini', stock: 7.31 }
];

const sqlDe = patron => mockQuery.mock.calls
  .map(c => ({ sql: String(c[0]), params: c[1] }))
  .filter(c => c.sql.includes(patron));

beforeEach(() => mockQuery.mockClear());

describe('GET /api/auditoria/entradas — expone el vínculo con el catálogo', () => {
  test('las filas de Almacén traen proveedor_id y el nombre canónico', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM ingresos_vigilancia/.test(sql)) return { rows: [], rowCount: 0 };
      if (/proveedor_catalogo/.test(sql)) return {
        rows: [
          { id: 91, fecha_registro: '2026-10-01', numero_guia: 'G-1', proveedor: 'EUROPLAST', proveedor_id: 7, proveedor_catalogo: 'EUROPLAST SAC', producto_nombre: 'Preforma', cantidad: 5, foto_url: null },
          { id: 92, fecha_registro: '2026-10-02', numero_guia: 'G-2', proveedor: 'SIN ASOCIAR', proveedor_id: null, proveedor_catalogo: null, producto_nombre: 'Tapas', cantidad: 2, foto_url: null }
        ],
        rowCount: 2
      };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('get', '/api/auditoria/entradas', {});

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toHaveLength(2);
    // el endpoint ordena por fecha descendente: se busca por guía, no por posición
    const porGuia = new Map(res.cuerpo.map(f => [f.numero_guia, f]));
    expect(porGuia.get('G-1')).toMatchObject({ origen: 'ALMACEN', ingreso_id: 91, proveedor_id: 7, proveedor_catalogo: 'EUROPLAST SAC' });
    expect(porGuia.get('G-2')).toMatchObject({ origen: 'ALMACEN', ingreso_id: 92, proveedor_id: null, proveedor_catalogo: null });
    expect(sqlDe('LEFT JOIN proveedores p ON p.id = a.proveedor_id')).toHaveLength(1);
  });
});

describe('GET /api/auditoria/proveedores — lista mínima del catálogo', () => {
  test('sirve id y nombre para cualquier rol que vea Auditoría', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/SELECT id, nombre FROM proveedores ORDER BY nombre/.test(sql)) {
        return { rows: [{ id: 7, nombre: 'EUROPLAST SAC' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('get', '/api/auditoria/proveedores', { rol: 'produccion' });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toEqual([{ id: 7, nombre: 'EUROPLAST SAC' }]);
    expect(sqlDe('SELECT id, nombre FROM proveedores ORDER BY nombre')).toHaveLength(1);
  });
});

describe('POST /api/auditoria/vincular-proveedores', () => {
  test('vincula en lote lo único que empata y devuelve el conteo', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/SELECT id, proveedor FROM registro_ingresos_almacen/.test(sql)) {
        return {
          rows: [
            { id: 11, proveedor: 'EUROPLAST' },        // contenido único de "EUROPLAST SAC"
            { id: 12, proveedor: 'IMPORTADORA XYZ' }   // sin coincidencia
          ],
          rowCount: 2
        };
      }
      if (/SELECT id, nombre FROM proveedores ORDER BY id/.test(sql)) {
        return { rows: [{ id: 7, nombre: 'EUROPLAST SAC' }], rowCount: 1 };
      }
      if (/UPDATE registro_ingresos_almacen r SET proveedor_id/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/auditoria/vincular-proveedores', {});

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toEqual({ success: true, vinculados: 1, revisadas: 2 });
    const upd = mockQuery.mock.calls.find(c => /UPDATE registro_ingresos_almacen r SET proveedor_id/.test(String(c[0])));
    expect(upd[1]).toEqual([[11], [7]]);
    expect(mockQuery.mock.calls.some(c => String(c[0]).trim() === 'BEGIN')).toBe(true);
    expect(mockQuery.mock.calls.some(c => String(c[0]).trim() === 'COMMIT')).toBe(true);
  });

  test('un catálogo corto agregado después vincula el texto largo (EUROPLAST → EUROPLAST SAC)', async () => {
    // El ingreso dice "EUROPLAST SAC" y recién se dio de alta "EUROPLAST":
    // el contenido único empaña en cualquier dirección.
    mockQuery.mockImplementation(async (sql) => {
      if (/SELECT id, proveedor FROM registro_ingresos_almacen/.test(sql)) {
        return { rows: [{ id: 13, proveedor: 'EUROPLAST SAC' }], rowCount: 1 };
      }
      if (/SELECT id, nombre FROM proveedores ORDER BY id/.test(sql)) {
        return { rows: [{ id: 8, nombre: 'EUROPLAST' }], rowCount: 1 };
      }
      if (/UPDATE registro_ingresos_almacen r SET proveedor_id/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await invocar('post', '/api/auditoria/vincular-proveedores', {});

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toEqual({ success: true, vinculados: 1, revisadas: 1 });
    const upd = mockQuery.mock.calls.find(c => /UPDATE registro_ingresos_almacen r SET proveedor_id/.test(String(c[0])));
    expect(upd[1]).toEqual([[13], [8]]);
  });
});

describe('POST /api/auditoria/vincular-ingreso — vínculo manual fila por fila', () => {
  function montarVinculo({ proveedorExiste = true, ingresoExiste = true } = {}) {
    mockQuery.mockImplementation(async (sql) => {
      if (/SELECT id FROM proveedores WHERE id/.test(sql)) return { rows: proveedorExiste ? [{ id: 7 }] : [], rowCount: proveedorExiste ? 1 : 0 };
      if (/UPDATE registro_ingresos_almacen SET proveedor_id/.test(sql)) return { rows: [], rowCount: ingresoExiste ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    });
  }

  test('valida proveedor e ingreso y actualiza la fila', async () => {
    montarVinculo();

    const res = await invocar('post', '/api/auditoria/vincular-ingreso', {
      body: { ingreso_id: 3, proveedor_id: 7 }
    });

    expect(res.statusCode).toBe(200);
    expect(res.cuerpo).toEqual({ success: true, proveedor_id: 7 });
    const upd = mockQuery.mock.calls.find(c => /UPDATE registro_ingresos_almacen SET proveedor_id/.test(String(c[0])));
    expect(upd[1]).toEqual([7, 3]);
  });

  test('un proveedor que ya no está en el catálogo responde 404 sin tocar nada', async () => {
    montarVinculo({ proveedorExiste: false });

    const res = await invocar('post', '/api/auditoria/vincular-ingreso', {
      body: { ingreso_id: 3, proveedor_id: 77 }
    });

    expect(res.statusCode).toBe(404);
    expect(sqlDe('UPDATE registro_ingresos_almacen SET proveedor_id')).toHaveLength(0);
  });

  test('un ingreso inexistente responde 404', async () => {
    montarVinculo({ ingresoExiste: false });

    const res = await invocar('post', '/api/auditoria/vincular-ingreso', {
      body: { ingreso_id: 99999, proveedor_id: 7 }
    });

    expect(res.statusCode).toBe(404);
    expect(res.cuerpo.mensaje).toContain('ingreso');
  });

  test('body incompleto responde 400', async () => {
    montarVinculo();

    const res = await invocar('post', '/api/auditoria/vincular-ingreso', { body: {} });

    expect(res.statusCode).toBe(400);
    expect(sqlDe('UPDATE registro_ingresos_almacen SET proveedor_id')).toHaveLength(0);
  });
});

describe('POST /api/almacen/conformidad — guarda el proveedor del catálogo', () => {
  function montar(ingreso, catalogo) {
    mockQuery.mockImplementation(async (sql, params = []) => {
      if (/FROM ingresos_vigilancia WHERE id/.test(sql)) return { rows: [ingreso], rowCount: 1 };
      if (/SELECT id, nombre FROM proveedores ORDER BY id/.test(sql)) return { rows: catalogo, rowCount: catalogo.length };
      if (/LOWER\(BTRIM\(nombre\)\) = LOWER\(BTRIM\(\$1\)\)/.test(sql)) {
        const t = String(params[0]).trim().toLowerCase();
        return { rows: CANONICOS.filter(f => f.nombre.trim().toLowerCase() === t) };
      }
      if (/^SELECT id, nombre, stock FROM inventario$/.test(sql.trim())) return { rows: CANONICOS };
      if (/INSERT INTO inventario \(nombre, categoria, stock/.test(sql)) return { rows: [{ id: 200 }], rowCount: 1 };
      if (/UPDATE inventario SET stock = stock/.test(sql)) return { rows: [{ stock: 200 }], rowCount: 1 };
      if (/UPDATE ingresos_vigilancia SET estado/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  const ingresoCon = (proveedor) => ({
    id: 5, numero_guia: 'T001-1', proveedor,
    items_json: JSON.stringify([{ nombre: 'Etiquetas b-1 1lt', cantidad_fisica: 100, cantidad_guia: 100 }])
  });

  test('un texto del catálogo se liga al proveedor y se guarda en proveedor_id', async () => {
    montar(ingresoCon('EUROPLAST'), [{ id: 7, nombre: 'EUROPLAST SAC' }]);

    const res = await invocar('post', '/api/almacen/conformidad', {
      body: { ingreso_id: 5, usuario_almacen: 'admin' }
    });

    expect(res.statusCode).toBe(200);
    const reg = sqlDe('INSERT INTO registro_ingresos_almacen');
    expect(reg).toHaveLength(1);
    expect(reg[0].sql).toContain('proveedor_id');
    // [numero_guia, proveedor, proveedor_id, producto, cantidad, estado, articulo_id]
    expect(reg[0].params.slice(0, 3)).toEqual(['T001-1', 'EUROPLAST', 7]);
  });

  test('un proveedor fuera del catálogo deja proveedor_id nulo y el texto intacto', async () => {
    montar(ingresoCon('IMPORTADORA XYZ'), [{ id: 7, nombre: 'EUROPLAST SAC' }]);

    const res = await invocar('post', '/api/almacen/conformidad', {
      body: { ingreso_id: 5, usuario_almacen: 'admin' }
    });

    expect(res.statusCode).toBe(200);
    const reg = sqlDe('INSERT INTO registro_ingresos_almacen');
    expect(reg).toHaveLength(1);
    expect(reg[0].params.slice(0, 3)).toEqual(['T001-1', 'IMPORTADORA XYZ', null]);
  });

  test('la guía trae el nombre largo y el catálogo el corto (EUROPLAST SAC → EUROPLAST)', async () => {
    montar(ingresoCon('EUROPLAST SAC'), [{ id: 8, nombre: 'EUROPLAST' }]);

    const res = await invocar('post', '/api/almacen/conformidad', {
      body: { ingreso_id: 5, usuario_almacen: 'admin' }
    });

    expect(res.statusCode).toBe(200);
    const reg = sqlDe('INSERT INTO registro_ingresos_almacen');
    expect(reg).toHaveLength(1);
    expect(reg[0].params.slice(0, 3)).toEqual(['T001-1', 'EUROPLAST SAC', 8]);
  });
});
