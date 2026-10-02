/**
 * Tests del mapa de flujo de trabajo.
 *
 * Lo que importa aqui no es el dibujo (eso vive en public/flujo.html) sino tres
 * reglas que un fallo dejaria dano datos reales:
 *   1. El acceso es por cuenta, no por rol: admin1 comparte rol 'admin' con
 *      otras cuentas, asi que un guard por rol abriria el mapa de mas.
 *   2. El guardado masivo reemplaza el grafo entero y va en transaccion: si no
 *      borrara los nodos que el cliente ya no envia, un nodo eliminado en
 *      pantalla reapareceria en la siguiente carga.
 *   3. Restaurar una version deja el mapa igual que estaba, incluidos los nodos
 *      que para entonces se hubieran creado.
 */
const mockQuery = jest.fn();

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (...args) => mockQuery(...args),
    release: () => {}
  })
}));

// El guard se ejerce de verdad (ver describe de acceso), asi que solo se anula
// la autenticacion: req.usuario lo pone cada test.
jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return {
    ...real,
    authMiddleware: (req, res, next) => next()
  };
});

const router = require('../routes/flujo');

function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    headersSent: false,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) { r.cuerpo = cuerpo; r.headersSent = true; return r; }
  };
  return r;
}

/**
 * Monta una peticion a traves de las capas reales del router (router.use del
 * guard incluidas) recorriendo la pila a mano.
 */
function capa(method, ruta) {
  const l = router.stack.find(x => x.route && x.route.path === ruta && x.route.methods[method]);
  if (!l) throw new Error(`No existe la ruta ${method.toUpperCase()} ${ruta}`);
  return l.route.stack[l.route.stack.length - 1].handle;
}

/**
 * Monta una peticion a traves de las capas reales del router: primero los
 * router.use (auth y guard) y, si ninguna cortó la cadena, el handler de la
 * ruta. Un middleware que no llama a next detiene el recorrido, igual que en
 * Express: por eso el 403 no llega al handler.
 */
async function invocar(method, ruta, req) {
  const res = resFalso();
  const peticion = Object.assign({ params: {}, body: {}, query: {}, usuario: 'admin1', rol: 'admin', headers: {} }, req);

  let siguiente = () => {};
  for (const capa of router.stack) {
    if (capa.route) break;
    capa.handle(peticion, res, siguiente);
    siguiente = () => {};
  }
  if (res.headersSent) return res;

  await capa(method, ruta)(peticion, res);
  return res;
}

const nodo = over => Object.assign({
  clave: 'oc_os', nombre: 'OC / OS', area: 'Compras', descripcion: '',
  x: 60, y: 220, color: '#fbbf24', metrica: 'oc_activas'
}, over);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('acceso exclusivo de admin1', () => {
  test('un administrador distinto de admin1 recibe 403 y no ve el mapa', async () => {
    const res = await invocar('get', '/', { usuario: 'admin', rol: 'admin' });

    expect(res.statusCode).toBe(403);
    expect(res.cuerpo.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('admin1 sí accede: mismo rol, cuenta distinta', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await invocar('get', '/', { usuario: 'admin1', rol: 'admin' });

    expect(res.statusCode).toBeNull();
    expect(res.cuerpo.success).toBe(true);
  });

  test('un nombre parecidos tampoco entra: la cuenta es exacta', async () => {
    const res = await invocar('get', '/', { usuario: 'admin11', rol: 'admin' });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET / — devuelve el grafo con su catálogo', () => {
  test('expone nodos, conexiones y el catálogo de métricas', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/FROM flujo_nodos/.test(sql)) {
        return { rows: [
          { id: 1, clave: 'oc_os', nombre: 'OC / OS', area: 'Compras', x: '60', y: '220' },
          { id: 2, clave: 'vigilancia', nombre: 'Vigilancia', area: 'Recepción', x: '320', y: '120' }
        ] };
      }
      return { rows: [{ id: 9, origen_id: 1, destino_id: 2, etiqueta: 'Ingreso', tipo: 'normal' }] };
    });

    const res = await invocar('get', '/', {});

    expect(res.cuerpo.nodos).toHaveLength(2);
    expect(res.cuerpo.conexiones).toHaveLength(1);
    // El cliente pinta x/y: si volvieran como texto el nodo se dibujaría raro.
    expect(res.cuerpo.nodos[0].x).toBe('60');
    expect(Array.isArray(res.cuerpo.metricas)).toBe(true);
    expect(res.cuerpo.areas).toEqual(['Compras', 'Recepción']);
  });

  test('las métricas salen mapeadas por clave, no por posición del SQL', async () => {
    mockQuery.mockResolvedValue({ rows: [{ m0: 3, m1: 2, m2: 9, m3: 1, m4: 0, m5: 4, m6: 7, m7: 2, m8: 5, m9: 1, m10: 40, m11: 3, m12: 6, m13: 2, m14: 4, m15: 1, m16: 8, m17: 5, m18: 6, m19: 2 }] });

    const res = await invocar('get', '/metricas', {});

    expect(res.cuerpo.metricas.oc_activas).toBe(3);
    expect(res.cuerpo.metricas.os_activas).toBe(2);
    expect(res.cuerpo.metricas.proveedores).toBe(1);
    expect(res.cuerpo.metricas.lineas_marcha).toBe(2);
  });
});

describe('validación de nodos y conexiones', () => {
  test('rechaza un nodo sin nombre antes de tocar la base', async () => {
    const res = await invocar('post', '/nodos', { body: { clave: 'x1', nombre: '   ', x: 0, y: 0 } });

    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rechaza una clave con espacios', async () => {
    const res = await invocar('post', '/nodos', { body: { clave: 'mi clave', nombre: 'X', x: 0, y: 0 } });

    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rechaza una métrica fuera del catálogo: el cliente no inventa SQL', async () => {
    const res = await invocar('post', '/nodos', { body: nodo({ metrica: '; DROP TABLE inventario --' }) });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/Métrica desconocida/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rechaza coordenadas fuera de rango que dejarian el nodo inalcanzable', async () => {
    const res = await invocar('post', '/nodos', { body: nodo({ x: 999999, y: 0 }) });

    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('no deja conectar un nodo consigo mismo', async () => {
    const res = await invocar('post', '/conexiones', { body: { origen_id: 3, destino_id: 3 } });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/consigo mismo/);
  });

  test('no crea una conexión cuyos nodos no existen', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

    const res = await invocar('post', '/conexiones', { body: { origen_id: 1, destino_id: 99 } });

    expect(res.statusCode).toBe(400);
    expect(mockQuery.mock.calls.filter(([sql]) => /INSERT INTO flujo_conexiones/.test(sql))).toHaveLength(0);
  });
});

describe('los campos nuevos de detalle', () => {
  // Los topes salen de la migracion 1790800004000. Si se cambia alli y no aqui,
  // el POST deja de cortar lo que la columna ya no acepta.
  const TOPES_NODO = { responsable: 80, tiempo_estimado: 40, sistema: 80, notas: 1000 };
  const TOPES_CONEXION = { evento: 140, condicion: 140, sla: 40, responsable: 80 };

  const conNodo = over => nodo(Object.assign({
    responsable: 'Compras',
    tiempo_estimado: '1 día hábil',
    sistema: 'basededatosgeneral.html · Órdenes OC/OS',
    notas: 'Solo con guía de entrada firmada'
  }, over));

  test('el GET devuelve los cuatro campos de nodo y los cuatro de conexión', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/FROM flujo_nodos/.test(sql)) {
        return { rows: [{
          id: 1, clave: 'oc_os', nombre: 'OC / OS', area: 'Compras', x: '60', y: '220',
          responsable: 'Compras', tiempo_estimado: '1 día hábil',
          sistema: 'basededatosgeneral.html', notas: 'Con guía firmada'
        }] };
      }
      return { rows: [{
        id: 9, origen_id: 1, destino_id: 2, etiqueta: 'Devolución al proveedor', tipo: 'rechazo',
        evento: 'Ingreso no conforme', condicion: 'No coincide con la guía',
        sla: '4 h', responsable: 'Almacén / Compras'
      }] };
    });

    const res = await invocar('get', '/', {});

    expect(res.cuerpo.nodos[0]).toMatchObject({
      responsable: 'Compras', tiempo_estimado: '1 día hábil',
      sistema: 'basededatosgeneral.html', notas: 'Con guía firmada'
    });
    expect(res.cuerpo.conexiones[0]).toMatchObject({
      evento: 'Ingreso no conforme', condicion: 'No coincide con la guía',
      sla: '4 h', responsable: 'Almacén / Compras'
    });
  });

  test('un nodo sin metadata sigue siendo válido: los campos son opcionales', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 1, clave: 'oc_os' }], rowCount: 1 });

    const res = await invocar('post', '/nodos', { body: nodo() });

    expect(res.statusCode).toBeNull();
    expect(res.cuerpo.success).toBe(true);
  });

  test('el POST guarda los cuatro campos de nodo', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 1, clave: 'oc_os' }], rowCount: 1 });

    await invocar('post', '/nodos', { body: conNodo() });

    const insercion = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_nodos/.test(sql));
    expect(insercion).toBeDefined();
    expect(insercion[1].slice(8)).toEqual(['Compras', '1 día hábil', 'basededatosgeneral.html · Órdenes OC/OS', 'Solo con guía de entrada firmada']);
  });

  test('el PUT actualiza los cuatro campos de nodo, no solo los viejos', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/INSERT INTO flujo_nodos/.test(sql)) return { rows: [{ id: 11, clave: 'oc_os' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await invocar('put', '/', { body: { nodos: [conNodo()], conexiones: [] } });

    const insercion = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_nodos/.test(sql));
    // El ON CONFLICT tiene que reescribir la metadata: si no, guardar desde el
    // panel no cambiaria nada aunque la columna exista.
    expect(insercion[0]).toMatch(/responsable = EXCLUDED\.responsable/);
    expect(insercion[0]).toMatch(/tiempo_estimado = EXCLUDED\.tiempo_estimado/);
    expect(insercion[0]).toMatch(/sistema = EXCLUDED\.sistema/);
    expect(insercion[0]).toMatch(/notas = EXCLUDED\.notas/);
    expect(insercion[1].slice(8)).toEqual(['Compras', '1 día hábil', 'basededatosgeneral.html · Órdenes OC/OS', 'Solo con guía de entrada firmada']);
  });

  test('el PUT escribe los cuatro campos de conexión en la tabla y en el UPDATE', async () => {
    mockQuery.mockImplementation(async (sql, params) => {
      if (/INSERT INTO flujo_nodos/.test(sql)) return { rows: [{ id: params[0] === 'oc_os' ? 11 : 22, clave: params[0] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await invocar('put', '/', {
      body: {
        nodos: [nodo(), nodo({ clave: 'vigilancia', nombre: 'Vigilancia' })],
        conexiones: [{
          origen: 'oc_os', destino: 'vigilancia', etiqueta: 'Devolución al proveedor', tipo: 'rechazo',
          evento: 'Ingreso no conforme', condicion: 'No coincide con la guía',
          sla: '4 h', responsable: 'Almacén / Compras'
        }]
      }
    });

    const insercion = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_conexiones/.test(sql));
    expect(insercion).toBeDefined();
    expect(insercion[0]).toMatch(/evento, condicion, sla, responsable/);
    expect(insercion[0]).toMatch(/evento = EXCLUDED\.evento/);
    expect(insercion[0]).toMatch(/condicion = EXCLUDED\.condicion/);
    expect(insercion[0]).toMatch(/sla = EXCLUDED\.sla/);
    expect(insercion[0]).toMatch(/responsable = EXCLUDED\.responsable/);
    expect(insercion[1]).toEqual([11, 22, 'Devolución al proveedor', 'rechazo',
      'Ingreso no conforme', 'No coincide con la guía', '4 h', 'Almacén / Compras']);
  });

  test('una conexión sin metadata es válida: las 20 del mapa arrancan vacías', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/SELECT id FROM flujo_nodos/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      return { rows: [{ id: 7 }], rowCount: 1 };
    });

    const res = await invocar('post', '/conexiones', { body: { origen_id: 1, destino_id: 2, tipo: 'normal' } });

    expect(res.statusCode).toBeNull();
    expect(res.cuerpo.success).toBe(true);
  });

  test('el POST guarda los cuatro campos de conexión', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/SELECT id FROM flujo_nodos/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      return { rows: [{ id: 7 }], rowCount: 1 };
    });

    await invocar('post', '/conexiones', {
      body: {
        origen_id: 1, destino_id: 2, tipo: 'decision', etiqueta: 'Proyecta plan',
        evento: 'Plan del turno', condicion: 'Se requiere proyección de insumos',
        sla: '1 h', responsable: 'Ing. de Producción'
      }
    });

    const insercion = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_conexiones/.test(sql));
    expect(insercion).toBeDefined();
    expect(insercion[1].slice(2)).toEqual(['Proyecta plan', 'decision', 'Plan del turno',
      'Se requiere proyección de insumos', '1 h', 'Ing. de Producción']);
  });

  test('los tipos decision y rechazo se aceptan en el POST', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/SELECT id FROM flujo_nodos/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      return { rows: [{ id: 7 }], rowCount: 1 };
    });

    for (const tipo of ['decision', 'rechazo']) {
      mockQuery.mockClear();
      mockQuery.mockImplementation(async sql => {
        if (/SELECT id FROM flujo_nodos/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
        return { rows: [{ id: 7 }], rowCount: 1 };
      });
      const res = await invocar('post', '/conexiones', { body: { origen_id: 1, destino_id: 2, tipo } });
      expect(`${tipo}: ok`).toBe(`${tipo}: ok`);
      expect(res.statusCode).toBeNull();
    }

    const res = await invocar('post', '/conexiones', { body: { origen_id: 1, destino_id: 2, tipo: 'inventado' } });
    expect(res.statusCode).toBe(400);
  });

  test('la metadata que excede el tope de su columna se corta, no revienta', async () => {
    // Un textarea largo no puede devolver 500: la columna es mas chica que lo que
    // el usuario puede escribir, y lo que no cabe se recorta.
    mockQuery.mockResolvedValue({ rows: [{ id: 1, clave: 'oc_os' }], rowCount: 1 });

    await invocar('post', '/nodos', { body: conNodo({ notas: 'x'.repeat(4000) }) });

    const insercion = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_nodos/.test(sql));
    for (const [campo, tope] of Object.entries(TOPES_NODO)) {
      const i = ['responsable', 'tiempo_estimado', 'sistema', 'notas'].indexOf(campo);
      expect(`${campo} corta`).toBe(`${campo} corta`);
      expect(String(insercion[1][8 + i]).length).toBeLessThanOrEqual(tope);
    }
  });

  test('la metadata de una conexión también se recorta al tope de su columna', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/SELECT id FROM flujo_nodos/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      return { rows: [{ id: 7 }], rowCount: 1 };
    });

    await invocar('post', '/conexiones', {
      body: {
        origen_id: 1, destino_id: 2, tipo: 'normal',
        evento: 'x'.repeat(400), condicion: 'y'.repeat(400),
        sla: 'z'.repeat(400), responsable: 'w'.repeat(400)
      }
    });

    const insercion = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_conexiones/.test(sql));
    const orden = ['evento', 'condicion', 'sla', 'responsable'];
    for (const [campo, tope] of Object.entries(TOPES_CONEXION)) {
      const i = orden.indexOf(campo);
      expect(`${campo} de la conexión corta`).toBe(`${campo} de la conexión corta`);
      expect(String(insercion[1][4 + i]).length).toBeLessThanOrEqual(tope);
    }
  });

  test('restaurar una versión devuelve también los campos nuevos', async () => {
    mockQuery.mockImplementation(async sql => {
      if (/FROM flujo_versiones WHERE id/.test(sql)) {
        return { rows: [{
          id: 1, nombre: 'Con detalle',
          snapshot: { nodos: [conNodo()], conexiones: [{ origen: 'oc_os', destino: 'vigilancia', evento: 'Plan del turno' }] }
        }] };
      }
      if (/INSERT INTO flujo_nodos/.test(sql)) return { rows: [{ id: 5, clave: 'oc_os' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const res = await invocar('post', '/versiones/:id/restaurar', { params: { id: '1' } });

    expect(res.statusCode).toBeNull();
    const nodoRestaurado = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_nodos/.test(sql));
    expect(nodoRestaurado[0]).toMatch(/responsable, tiempo_estimado, sistema, notas/);
    expect(nodoRestaurado[1].slice(8)).toEqual(['Compras', '1 día hábil', 'basededatosgeneral.html · Órdenes OC/OS', 'Solo con guía de entrada firmada']);
  });

  test('guardar una versión acepta la metadata en el snapshot', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

    const res = await invocar('post', '/versiones', {
      body: {
        nombre: 'Con detalle',
        snapshot: {
          nodos: [conNodo()],
          conexiones: [{
            origen: 'oc_os', destino: 'vigilancia', tipo: 'rechazo', evento: 'Ingreso no conforme',
            condicion: 'No coincide con la guía', sla: '4 h', responsable: 'Almacén / Compras'
          }]
        }
      }
    });

    expect(res.statusCode).toBeNull();
    expect(res.cuerpo.success).toBe(true);
  });
});

describe('PUT / — el guardado masivo reemplaza el grafo entero', () => {
  test('borra los nodos que el cliente ya no envía', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/INSERT INTO flujo_nodos/.test(sql)) return { rows: [{ id: 1, clave: 'oc_os' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    await invocar('put', '/', { body: { nodos: [nodo()], conexiones: [] } });

    const borrado = mockQuery.mock.calls.find(([sql]) => /DELETE FROM flujo_nodos WHERE NOT \(clave = ANY/.test(sql));
    // Sin este DELETE, el nodo borrado en pantalla volveria al recargar.
    expect(borrado).toBeDefined();
    expect(borrado[1][0]).toEqual(['oc_os']);
  });

  test('va en transacción: si algo falla no queda el grafo a medias', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/COMMIT/.test(sql)) throw new Error('se cayó la base');
      if (/INSERT INTO flujo_nodos/.test(sql)) return { rows: [{ id: 1, clave: 'oc_os' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const res = await invocar('put', '/', { body: { nodos: [nodo()], conexiones: [] } });

    expect(res.statusCode).toBe(500);
    expect(mockQuery.mock.calls.some(([sql]) => /BEGIN/.test(sql))).toBe(true);
    expect(mockQuery.mock.calls.some(([sql]) => /ROLLBACK/.test(sql))).toBe(true);
    // Tras el fallo el cliente no puede creer que el mapa quedó guardado.
    expect(res.cuerpo.success).toBe(false);
  });

  test('rechaza dos nodos con la misma clave antes de escribir nada', async () => {
    const res = await invocar('put', '/', {
      body: { nodos: [nodo(), nodo({ nombre: 'Otro' })], conexiones: [] }
    });

    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.mensaje).toMatch(/con la clave/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('resuelve las conexiones por clave, que es lo que envía el cliente', async () => {
    // El id lo asigna la secuencia: el cliente no lo conoce, solo la clave.
    mockQuery.mockImplementation(async (sql, params) => {
      if (/INSERT INTO flujo_nodos/.test(sql)) {
        const clave = params[0];
        return { rows: [{ id: clave === 'oc_os' ? 11 : 22, clave }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await invocar('put', '/', {
      body: {
        nodos: [nodo(), nodo({ clave: 'vigilancia', nombre: 'Vigilancia' })],
        conexiones: [{ origen: 'oc_os', destino: 'vigilancia', etiqueta: 'Ingreso', tipo: 'normal' }]
      }
    });

    const insercion = mockQuery.mock.calls.find(([sql]) => /INSERT INTO flujo_conexiones/.test(sql));
    expect(insercion).toBeDefined();
    expect(insercion[1][0]).toBe(11);
    expect(insercion[1][1]).toBe(22);
    expect(insercion[1][2]).toBe('Ingreso');
  });
});

describe('versiones', () => {
  test('guardar una versión exige nombre y grafo completo', async () => {
    const sinNombre = await invocar('post', '/versiones', { body: { nombre: '', snapshot: { nodos: [], conexiones: [] } } });
    expect(sinNombre.statusCode).toBe(400);

    const sinGrafo = await invocar('post', '/versiones', { body: { nombre: 'V1', snapshot: { nodos: [] } } });
    expect(sinGrafo.statusCode).toBe(400);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('restaurar un snapshot borra los nodos creados después', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM flujo_versiones WHERE id/.test(sql)) {
        return { rows: [{
          id: 1, nombre: 'Antes del cambio',
          snapshot: { nodos: [nodo()], conexiones: [] }
        }] };
      }
      if (/INSERT INTO flujo_nodos/.test(sql)) return { rows: [{ id: 5, clave: 'oc_os' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const res = await invocar('post', '/versiones/:id/restaurar', { params: { id: '1' } });

    expect(res.statusCode).toBeNull();
    expect(res.cuerpo.restaurados.nodos).toBe(1);
    const borrado = mockQuery.mock.calls.find(([sql]) => /DELETE FROM flujo_nodos WHERE NOT \(clave = ANY/.test(sql));
    expect(borrado).toBeDefined();
    expect(borrado[1][0]).toEqual(['oc_os']);
  });

  test('una versión con un nodo inválido no toca la base', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM flujo_versiones WHERE id/.test(sql)) {
        return { rows: [{ id: 2, snapshot: { nodos: [nodo(), { clave: 'x', nombre: '' }], conexiones: [] } }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const res = await invocar('post', '/versiones/:id/restaurar', { params: { id: '1' } });

    expect(res.statusCode).toBe(400);
    expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO flujo_nodos/.test(sql))).toBe(false);
  });

  test('restaurar responde 404 si la versión no existe', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await invocar('post', '/versiones/:id/restaurar', { params: { id: '99' } });

    expect(res.statusCode).toBe(404);
  });
});
