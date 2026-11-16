/**
 * PARADO DE SERVICIO (servicios externos de soplado).
 *
 * Reglas que se cuidan aqui:
 *  1. La parada cierra el saldo del servicio y deja el contador en 0: se
 *      exige decision (MERMA o ALMACEN) por cada insumo con saldo; si falta
 *      uno no se cierra a medias.
 *  2. MERMA no mueve inventario (el material ya salio con el envio).
 *  3. ALMACEN suma el saldo al MISMO articulo y lo historialea con
 *      origen servicio_parada.
 *  4. Las cantidades las calcula el servidor: la pantalla solo manda las
 *      decisiones, asi que un saldo viejo no cierra de mas.
 *  5. El panel resta lo liquidado por paradas del saldo que muestra.
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

// Solo se anula la autenticacion; los guards por rol se ejercen de verdad.
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

// Las reglas reciben (texto, args) para poder responder por parametro.
function responder(reglas) {
  mockQuery.mockImplementation(async (sql, args) => {
    const texto = String(sql || '').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(texto)) return { rows: [], rowCount: 0 };
    for (const [patron, respuesta] of reglas) {
      if (patron instanceof RegExp ? patron.test(texto) : texto.includes(patron)) {
        return typeof respuesta === 'function' ? respuesta(texto, args) : respuesta;
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

const SQL = {
  saldoEnvios: /FROM servicios_envios/,
  saldoConsumido: /AS consumido/,
  saldoParadas: /AS liquidado/,
  insParada: /INSERT INTO servicios_paradas \(fecha/,
  insItem: /INSERT INTO servicios_paradas_items/,
  artPorId: /SELECT id, nombre, categoria, stock FROM inventario WHERE id/,
  faltaNombres: /WHERE id = ANY/,
  updateMas: /UPDATE inventario SET stock = stock \+ \$1/,
  updEstado: /UPDATE inventario SET estado/,
  historial: /INSERT INTO historial_inventario/,
  panelEnvios: /FROM servicios_envios GROUP BY/,
  panelEntregado: /cant_etiquetas/,
  panelLiquidado: /JOIN servicios_paradas p ON/,
  panelParadas: /SELECT \* FROM servicios_paradas ORDER/,
  panelItemsParada: /SELECT \* FROM servicios_paradas_items ORDER/,
  panelGuias: /FROM servicios_guias ORDER BY/
};

// Saldo base: SAUÑE con etiqueta 10 MILL y preforma 3 MILL, sin consumo.
function saldoBase() {
  return [
    [SQL.saldoEnvios, {
      rows: [
        { articulo_id: 4, enviado: '10' },
        { articulo_id: 5, enviado: '3' }
      ],
      rowCount: 2
    }],
    [SQL.saldoConsumido, { rows: [], rowCount: 0 }],
    [SQL.saldoParadas, { rows: [], rowCount: 0 }],
    [SQL.insParada, { rows: [{ id: 77 }], rowCount: 1 }],
    [SQL.insItem, { rows: [], rowCount: 1 }],
    [SQL.updateMas, { rows: [], rowCount: 1 }],
    [SQL.updEstado, { rows: [], rowCount: 1 }],
    [SQL.historial, { rows: [], rowCount: 1 }]
  ];
}

const ARTICULOS = {
  4: { id: 4, nombre: 'Et X', categoria: 'ETIQUETAS', stock: '100' },
  5: { id: 5, nombre: 'Preforma Y', categoria: 'PREFORMAS Y SERVICIOS', stock: '50' }
};

function responderConArticulos(reglas) {
  const conArticulos = [
    [SQL.artPorId, (t, args) => ({
      rows: ARTICULOS[args[0]] ? [ARTICULOS[args[0]]] : [],
      rowCount: ARTICULOS[args[0]] ? 1 : 0
    })],
    ...reglas
  ];
  responder(conArticulos);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('POST /api/servicios/parada: validacion', () => {
  test('rechaza servicio desconocido sin tocar la base', async () => {
    const res = await invocar('post', '/api/servicios/parada', {
      body: { servicio: 'X', items: [{ articulo_id: 4, decision: 'MERMA' }] }
    });
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rechaza una linea sin decision', async () => {
    responder(saldoBase());
    const res = await invocar('post', '/api/servicios/parada', {
      body: { servicio: 'SAUÑE', items: [{ articulo_id: 4 }] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch('decisión');
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos).toContain('ROLLBACK');
    expect(textos.some(t => SQL.insParada.test(t))).toBe(false);
  });

  test('rechaza una decision que no sea MERMA ni ALMACEN', async () => {
    responder(saldoBase());
    const res = await invocar('post', '/api/servicios/parada', {
      body: { servicio: 'SAUÑE', items: [{ articulo_id: 4, decision: 'VOLAR' }] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch('MERMA o ALMACEN');
  });

  test('no cierra a medias: falta decidir un insumo con saldo', async () => {
    responderConArticulos([
      ...saldoBase(),
      [SQL.faltaNombres, { rows: [{ id: 5, nombre: 'Preforma Y' }], rowCount: 1 }]
    ]);
    const res = await invocar('post', '/api/servicios/parada', {
      body: { servicio: 'SAUÑE', items: [{ articulo_id: 4, decision: 'MERMA' }] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch('Preforma Y');
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos).toContain('ROLLBACK');
    expect(textos.some(t => SQL.insParada.test(t))).toBe(false);
  });

  test('rechaza si el servicio ya esta en 0', async () => {
    responder([
      [SQL.saldoEnvios, { rows: [{ articulo_id: 4, enviado: '10' }], rowCount: 1 }],
      [SQL.saldoConsumido, { rows: [{ articulo_id: 4, consumido: '10' }], rowCount: 1 }],
      [SQL.saldoParadas, { rows: [], rowCount: 0 }]
    ]);
    const res = await invocar('post', '/api/servicios/parada', {
      body: { servicio: 'SAUÑE', items: [{ articulo_id: 4, decision: 'MERMA' }] }
    });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch('ya está en 0');
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos.some(t => SQL.insParada.test(t))).toBe(false);
  });
});

describe('POST /api/servicios/parada: liquidacion', () => {
  test('MERMA cierra el saldo sin mover inventario', async () => {
    responderConArticulos(saldoBase());
    const res = await invocar('post', '/api/servicios/parada', {
      body: {
        servicio: 'SAUÑE',
        items: [
          { articulo_id: 4, decision: 'MERMA' },
          { articulo_id: 5, decision: 'MERMA' }
        ],
        observacion: 'corte'
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.cuerpo.success).toBe(true);
    expect(res.cuerpo.mensaje).toMatch(/Contador en 0/i);
    const textos = mockQuery.mock.calls.map(c => String(c[0]));
    expect(textos.some(t => SQL.updateMas.test(t))).toBe(false);
    expect(textos.some(t => SQL.historial.test(t))).toBe(false);
    const items = mockQuery.mock.calls.filter(c => SQL.insItem.test(String(c[0])));
    expect(items).toHaveLength(2);
    expect(items[0][1]).toEqual([77, 4, 'Et X', 'ETIQUETA', 10, 'MERMA']);
    expect(items[1][1]).toEqual([77, 5, 'Preforma Y', 'PREFORMA', 3, 'MERMA']);
  });

  test('ALMACEN suma el saldo al mismo articulo y lo historialea', async () => {
    responderConArticulos(saldoBase());
    const res = await invocar('post', '/api/servicios/parada', {
      body: {
        servicio: 'SAUÑE',
        items: [
          { articulo_id: 4, decision: 'ALMACEN' },
          { articulo_id: 5, decision: 'MERMA' }
        ]
      }
    });
    expect(res.statusCode).toBe(200);
    const upd = mockQuery.mock.calls.find(c => SQL.updateMas.test(String(c[0])));
    // Solo la etiqueta (articulo 4) vuelve: 10 MILL a su stock.
    expect(upd[1]).toEqual([10, 4]);
    const hist = mockQuery.mock.calls.find(c => SQL.historial.test(String(c[0])));
    expect(hist[1][0]).toBe('INGRESO');
    expect(hist[1][1]).toBe('servicio_parada');
    expect(hist[1][2]).toBe('Et X');
    expect(hist[1][4]).toBe(4);
    expect(hist[1][5]).toBe(10);
    expect(hist[1][6]).toBe('SUMA');
    expect(hist[1][7]).toBe(100);
    expect(hist[1][8]).toBe(110);
  });
});

describe('GET /api/servicios/panel: el parado deja el contador en 0', () => {
  test('resta lo liquidado por paradas del saldo', async () => {
    responder([
      [SQL.panelEnvios, {
        rows: [{ servicio: 'SAUÑE', articulo_id: 4, articulo_nombre: 'Et X', tipo_item: 'ETIQUETA', enviado: '10' }],
        rowCount: 1
      }],
      [SQL.panelEntregado, { rows: [{ servicio: 'SAUÑE', articulo_id: 4, nombre: 'Et X', entregado: '3' }], rowCount: 1 }],
      [SQL.panelLiquidado, { rows: [{ servicio: 'SAUÑE', articulo_id: 4, liquidado: '4' }], rowCount: 1 }],
      [SQL.panelParadas, {
        rows: [{ id: 9, fecha: '2026-11-16', servicio: 'SAUÑE', usuario: 'admin1', observacion: 'prueba' }],
        rowCount: 1
      }],
      [SQL.panelItemsParada, {
        rows: [{ parada_id: 9, articulo_id: 4, articulo_nombre: 'Et X', tipo_item: 'ETIQUETA', saldo: '4', decision: 'MERMA' }],
        rowCount: 1
      }],
      [SQL.panelGuias, { rows: [], rowCount: 0 }]
    ]);
    const res = await invocar('get', '/api/servicios/panel');
    expect(res.statusCode).toBe(200);
    const saune = res.cuerpo.servicios.find(s => s.servicio === 'SAUÑE');
    // 10 enviados - 3 entregados - 4 liquidados por parada = 3.
    expect(saune.insumos[0].saldo).toBe(3);
    expect(saune.insumos[0].liquidado).toBe(4);
    expect(res.cuerpo.paradas).toHaveLength(1);
    expect(res.cuerpo.paradas[0].items[0].decision).toBe('MERMA');
  });
});
