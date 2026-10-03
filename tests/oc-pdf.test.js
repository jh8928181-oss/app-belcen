/**
 * Impresion de la orden de compra en PDF.
 *
 * Tres cosas se verifican aqui y las tres nacen de fallos concretos:
 *
 *   1. El reparto del IGV por linea tiene que volver a sumar exactamente el IGV
 *      de la orden. Si no, el PDF muestra una columna de IGV que no cuadra con la
 *      fila TOTALES, y ese es el error que hace desconfiar de una OC firmada.
 *   2. El PDF se descarga por header, no abriendo una pestana. Si la ruta no
 *      manda Content-Disposition, el boton del cliente abre el archivo en vez de
 *      bajarlo y la autenticacion por header no llega.
 *   3. Los cuentas y datos que imprime el documento vienen de tablas propias
 *      (proveedor_cuentas_bancarias, usuarios_sistema), no de texto pegado en la
 *      orden, asi que se pueden corregir sin volver a emitir.
 */

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const zlib = require('zlib');

/**
 * Saca el texto de un PDF de pdfkit sin usar pdfjs.
 *
 * pdf-parse necesita --experimental-vm-modules para correr dentro de Jest
 * (pdfjs-dist levanta un worker dinamico), y tocar el comando de test solo por
 * un archivo no vale la pena. Los flujos de contenido van comprimidos con
 * FlateDecode, asi que se inflan y se leen los operadores de dibujo de texto.
 *
 * Se decodifica en latin1 porque las fuentes estandar de pdfkit usan WinAnsi:
 * un acento es un byte suelto, no una secuencia UTF-8.
 */
/**
 * Convierte el flujo de contenido en texto legible.
 *
 * pdfkit escribe el texto de tres formas que hay que aplanar:
 *   ('asdf') Tj             texto plano
 *   [<4153> 20 <44> 0] TJ   hexadecimal, partido en fragmentos
 * Entre fragmentos hay numeros de kerning, y hay que distinguirlos del texto.
 * No se pueden borrar con un replace sobre la cadena entera: <5642...> empieza
 * con digitos y el numero se comeria los primeros, dejando un hexadecimal
 * mutilado que decodifica a basura. Por eso se parte el array en tokens y solo
 * se descartan los que SON un numero completo.
 */
function textoDeFlujo(flujo) {
  return flujo
    .replace(/\[([^\]]*)\]\s*TJ/g, (_, interior) => interior
      .split(/\s+/)
      .filter(token => !/^-?\d+(?:\.\d+)?$/.test(token))
      .join(''))
    .replace(/<([0-9A-Fa-f]+)>/g, (_, hex) => Buffer.from(hex, 'hex').toString('latin1'))
    .replace(/\(((?:\\.|[^\\()])*)\)/g, (_, txt) => txt);
}

function textoDelPdf(buffer) {
  return textoDeFlujo(extraerFlujos(buffer).join('\n'));
}

/** Devuelve los flujos de contenido ya desinflados. */
function extraerFlujos(buffer) {
  const trozos = [];
  const MARCA = Buffer.from('stream');
  const FIN = Buffer.from('endstream');
  let desde = 0;
  while (desde < buffer.length) {
    const inicio = buffer.indexOf(MARCA, desde);
    if (inicio === -1) break;
    const fin = buffer.indexOf(FIN, inicio);
    if (fin === -1) break;
    let crudo = buffer.subarray(inicio + MARCA.length, fin);
    // Entre "stream" y los datos hay un salto de linea que no es del flujo.
    while (crudo.length && (crudo[0] === 13 || crudo[0] === 10)) crudo = crudo.subarray(1);
    try {
      trozos.push(zlib.inflateSync(crudo).toString('latin1'));
    } catch (e) {
      // No todos los flujos van comprimidos; los que no, no traen texto.
    }
    desde = fin + FIN.length;
  }
  return trozos;
}

jest.mock('../db', () => ({
  query: (...args) => mockQuery(...args),
  connect: () => Promise.resolve({
    query: (...args) => mockQuery(...args),
    release: (...args) => mockRelease(...args)
  })
}));

// Solo se anula la autenticacion: req.usuario lo pone cada test y los guards de
// rol sealeza de verdad para comprobar que la ruta esta protegida.
jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, authMiddleware: (req, res, next) => next() };
});

const { app, camposEntregaDe, normalizarCuentasBancarias } = require('../index');
const { repartirIgv, datosMoneda, datosParaOrdenPDF } = require('../services/ocPdfDatos');
const { generarPDFOrdenCompra, nombreArchivoSeguro } = require('../services/pdfOrdenCompra');

function resFalso() {
  const r = {
    statusCode: null,
    cuerpo: null,
    headersSent: false,
    headers: {},
    buffer: null,
    terminado: null,
    status(codigo) { r.statusCode = codigo; return r; },
    json(cuerpo) {
      if (r.statusCode === null) r.statusCode = 200;
      r.cuerpo = cuerpo;
      r.headersSent = true;
      return r;
    },
    setHeader(clave, valor) { r.headers[clave.toLowerCase()] = valor; return r; },
    end(chunk) { r.buffer = chunk; r.headersSent = true; r.terminado = true; return r; }
  };
  return r;
}

/** Igual que en routes.bd-precios: se recorre la pila de la ruta, guard incluido. */
function pilaDe(method, ruta) {
  // Express registra los metodos en minuscula, asi que 'GET' no encontraria nada
  // aunque la ruta exista. Se normaliza para poder llamar con cualquiera.
  const metodo = method.toLowerCase();
  const pila = app.router ? app.router.stack : app._router.stack;
  const mio = ruta.split('/');
  const encaja = (registrado, solicitado) =>
    registrado.startsWith(':') || registrado.toLowerCase() === solicitado.toLowerCase();
  const candidatas = pila.filter(l => {
    if (!l.route || !l.route.methods[metodo]) return false;
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

/** Enruta cada consulta por su SQL, no por orden de llamada. */
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

const SQL = {
  ordenParaPDF: /FROM ordenes_compras_servicios o\s+LEFT JOIN proveedores/,
  itemsParaPDF: /FROM ordenes_items WHERE orden_id = \$1/,
  cuentasParaPDF: /FROM proveedor_cuentas_bancarias\s+WHERE proveedor_id = \$1/,
  emisorParaPDF: /FROM usuarios_sistema WHERE usuario = \$1/
};

const filas = (...rows) => ({ rows, rowCount: rows.length });

const ORDEN = {
  id: 7,
  tipo: 'OC',
  numero: '0462-2026',
  fecha_orden: '2026-10-01',
  estado: 'EMITIDA',
  observaciones: 'Entregar en planta principal',
  proveedor_id: 3,
  proveedor_nombre: 'CEMENTOS DEL SUR',
  proveedor_nombre_actual: 'CEMENTOS DEL SUR S.A.C.',
  ruc: '20512345678',
  telefono: '987654321',
  email: 'ventas@cementosdelsur.com',
  contacto: 'Juan Perez',
  direccion: 'Av. Los Frutales 123',
  total: 3233.10,
  igv_pct: 18,
  igv: 581.96,
  total_igv: 3815.06,
  moneda: 'PEN',
  usuario_registro: 'angelica',
  usuario_emision: 'angelica',
  lugar_entrega: 'Planta Principal',
  fecha_entrega: '2026-10-05',
  area_solicitante: 'Produccion',
  forma_pago: 'Credito 30 dias',
  horario_recepcion: 'L-V 8:00-12:00',
  atencion: 'Almacen central'
};

const ITEMS = [
  { descripcion: 'Cemento portland', unidad: 'BOLSA', cantidad: 100, precio: 20, subtotal: 2000 },
  { descripcion: 'Arena gruesa', unidad: 'M3', cantidad: 40, precio: 30.83, subtotal: 1233.20 }
];

const CUENTAS = [
  { banco: 'Interbank', tipo: 'C.C. Soles', numero: '200-12345678', moneda: 'PEN', titular: 'CEMENTOS DEL SUR S.A.C.' },
  { banco: 'BCP', tipo: 'C.C. Soles', numero: '570-87654321', moneda: 'PEN', titular: 'CEMENTOS DEL SUR S.A.C.' }
];

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockReset();
});

describe('reparto del IGV por linea', () => {
  test('las lineas suman exactamente el IGV de la orden', () => {
    // 18% de 3233.10 son 581.958: la orden guardo 581.96. Pero repartido linea
    // por linea y redondeado, 2000.00 da 360.00 y 1233.20 da 221.98, y esas dos
    // suman 581.98: sobran dos centimos que hay que repartir de mas.
    const partes = repartirIgv(ITEMS, 18, 581.96);

    // La suma exacta es la propiedad que importa: es la que hace que la columna
    // de IGV cuadre con la fila TOTALES.
    expect(partes[0] + partes[1]).toBeCloseTo(581.96, 10);
    expect(partes).toEqual([359.99, 221.97]);
  });

  test('el centimo sobrante va a la linea que perdio al redondear', () => {
    // Con un solo centimo de diferencia la linea exacta (2000.00 al 18% son
    // 360.00 clavados) no se toca: el ajuste cae en la que perdio algo al
    // redondear (1233.20 * 0.18 = 221.976). Asi el PDF nunca dice 360.01 en una
    // linea cuyo IGV exacto es 360.00.
    const partes = repartirIgv([{ subtotal: 2000 }, { subtotal: 1233.20 }], 18, 581.97);
    expect(partes).toEqual([360, 221.97]);
    expect(partes[0] + partes[1]).toBeCloseTo(581.97, 10);
  });

  test('el sobrante se corrige aunque haya muchas lineas', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ subtotal: 11.11 * (i + 1) }));
    const total = items.reduce((a, it) => a + it.subtotal, 0);
    // El IGV que guardo la orden: un solo redondeo sobre el total, no linea por linea.
    const igvOrden = Math.round(total * 18 / 100 * 100) / 100;
    const partes = repartirIgv(items, 18, igvOrden);
    const suma = partes.reduce((a, b) => a + b, 0);

    expect(suma).toBeCloseTo(igvOrden, 10);
    expect(igvOrden).toBeGreaterThan(0);
  });

  test('sin lineas no hay IGV que repartir', () => {
    expect(repartirIgv([], 18, 100)).toEqual([]);
  });

  test('un IGV de orden no numerico deja todas las lineas en cero', () => {
    expect(repartirIgv(ITEMS, 18, 'basura')).toEqual([0, 0]);
  });

  test('reparte sin salirse de un centimo por linea del IGV exacto', () => {
    // El ajuste va a las lineas con mayor residuo, asi que ninguna se mueve mas
    // de un centimo respecto de su propio redondeo.
    const items = [{ subtotal: 33.33 }, { subtotal: 66.67 }, { subtotal: 0.01 }];
    const partes = repartirIgv(items, 18, 18);
    items.forEach((it, i) => {
      const exacto = it.subtotal * 18 / 100;
      expect(Math.abs(partes[i] - exacto)).toBeLessThanOrEqual(0.01);
    });
  });
});

describe('moneda del PDF', () => {
  test('PEN y USD salen con simbolo y nombre largo', () => {
    expect(datosMoneda('PEN')).toEqual({ simbolo: 'S/', nombre: 'SOLES' });
    expect(datosMoneda('usd')).toEqual({ simbolo: '$', nombre: 'DOLARES' });
  });

  test('una moneda desconocida cae en soles en vez de imprimir undefined', () => {
    expect(datosMoneda('EUR').simbolo).toBe('S/');
    expect(datosMoneda(undefined).simbolo).toBe('S/');
  });
});

describe('nombre del archivo descargado', () => {
  test('el numero de orden se sanea para no romper el encabezado HTTP', () => {
    // Un numero con comillas o barra se iria de las comillas del
    // Content-Disposition y el navegador guardaria el archivo con otro nombre.
    expect(nombreArchivoSeguro('0462-2026', 7)).toBe('0462-2026');
    expect(nombreArchivoSeguro('04"62\\2026', 7)).not.toMatch(/["\\]/);
    expect(nombreArchivoSeguro('a\nb', 7)).not.toMatch(/[\r\n]/);
  });

  test('un numero vacio cae al id, que si es un numero', () => {
    expect(nombreArchivoSeguro('', 7)).toBe('7');
    expect(nombreArchivoSeguro('   ', 12)).toBe('12');
    expect(typeof nombreArchivoSeguro('', 7)).toBe('string');
  });
});

describe('lectura de datos para el PDF', () => {
  test('trae orden, items, cuentas y el emisor guardado en la orden', async () => {
    responder([
      [SQL.ordenParaPDF, filas(ORDEN)],
      [SQL.itemsParaPDF, filas(...ITEMS)],
      [SQL.cuentasParaPDF, filas(...CUENTAS)],
      [SQL.emisorParaPDF, filas({ nombre: 'Angelica Ruiz', cargo: 'Jefe de almacen', celular: '987654321' })]
    ]);

    const datos = await datosParaOrdenPDF({ query: mockQuery }, 7);

    expect(datos.orden.numero).toBe('0462-2026');
    expect(datos.items).toHaveLength(2);
    expect(datos.bancos).toHaveLength(2);
    expect(datos.emisor).toEqual({ nombre: 'Angelica Ruiz', cargo: 'Jefe de almacen', celular: '987654321' });
  });

  test('una orden inexistente devuelve null y no revienta', async () => {
    responder([[SQL.ordenParaPDF, { rows: [], rowCount: 0 }]]);
    await expect(datosParaOrdenPDF({ query: mockQuery }, 999)).resolves.toBeNull();
  });

  test('si el emisor no tiene nombre propio, se imprime el login', async () => {
    // Las ordenes anteriores a la migracion tienen usuarios sin nombre cargado:
    // el PDF mostraria un hueco en "Emitido por" donde deberia ir el login.
    responder([
      [SQL.ordenParaPDF, filas(ORDEN)],
      [SQL.itemsParaPDF, filas(...ITEMS)],
      [SQL.cuentasParaPDF, { rows: [], rowCount: 0 }],
      [SQL.emisorParaPDF, filas({ nombre: null, cargo: null, celular: null })]
    ]);

    const datos = await datosParaOrdenPDF({ query: mockQuery }, 7);
    expect(datos.emisor.nombre).toBe('angelica');
  });

  test('una orden vieja sin usuario_emision cae al de registro', async () => {
    responder([
      [SQL.ordenParaPDF, filas({ ...ORDEN, usuario_emision: null, usuario_registro: 'supervisor1' })],
      [SQL.itemsParaPDF, { rows: [], rowCount: 0 }],
      [SQL.cuentasParaPDF, { rows: [], rowCount: 0 }],
      [SQL.emisorParaPDF, filas({ nombre: 'Luis Vega', cargo: 'Supervisor', celular: null })]
    ]);

    const datos = await datosParaOrdenPDF({ query: mockQuery }, 7);
    expect(datos.emisor.nombre).toBe('Luis Vega');
  });

  test('un proveedor sin cuentas no corta el PDF', async () => {
    responder([
      [SQL.ordenParaPDF, filas(ORDEN)],
      [SQL.itemsParaPDF, filas(...ITEMS)],
      [SQL.cuentasParaPDF, { rows: [], rowCount: 0 }],
      [SQL.emisorParaPDF, { rows: [], rowCount: 0 }]
    ]);

    const datos = await datosParaOrdenPDF({ query: mockQuery }, 7);
    expect(datos.bancos).toEqual([]);
  });
});

describe('contenido del PDF', () => {
  test('genera un PDF de una pagina con los totales de la orden', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN,
      items: ITEMS,
      bancos: CUENTAS,
      emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe de almacen', celular: '987654321' }
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    // Firma de archivo PDF: si el buffer no empieza asi, el navegador no lo abre.
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');

    const texto = textoDelPdf(buffer);
    expect(texto).toContain('0462-2026');
    expect(texto).toContain('CEMENTOS DEL SUR');
    expect(texto).toContain('Cemento portland');
    expect(texto).toContain('3,815.06');
    expect(texto).toContain('581.96');
    expect(texto).toContain('3,233.10');
    expect(texto).toContain('Angelica Ruiz');
    expect(texto).toContain('Planta Principal');
    expect(texto).toContain('Credito 30 dias');
    expect(texto).toContain('200-12345678');
  });

  test('si la orden viene sin igv, se deriva del total y la tasa', async () => {
    // Una orden con igv nulo imprimia "S/ 0.00" en la columna de IGV junto a un
    // total de 3,815.06. El proveedor lee esa fila y devuelve la orden.
    const sinIgv = Object.assign({}, ORDEN, { igv: null });
    const texto = textoDelPdf(await generarPDFOrdenCompra({
      orden: sinIgv, items: ITEMS, bancos: [], emisor: { nombre: 'A', cargo: null, celular: null }
    }));
    expect(texto).toContain('581.96');
    // El fallo era la celda de la fila TOTALES, que lleva el simbolo delante.
    expect(texto).not.toContain('S/ 0.00');
  });

  test('una hora ausente sale como guion y no como hueco', async () => {
    // Una etiqueta sola, sin nada al lado, parece un campo que se perdio al
    // imprimir. El guion dice lo mismo que el resto de datos que faltan.
    const sinHora = Object.assign({}, ORDEN, { fecha_registro: null });
    const flujo = textoDeFlujo(extraerFlujos(await generarPDFOrdenCompra({
      orden: sinHora, items: ITEMS, bancos: [], emisor: { nombre: 'A', cargo: null, celular: null }
    })).join('\n'));

    // Cada texto va precedido de su matriz: "1 0 0 1 <x> <y> Tm". Despues viene
    // el nombre de la fuente y el texto; lo que sigue son operadores (ET, Q...)
    // que no forman parte de lo impreso.
    const fragmentos = [...flujo.split('BT').slice(1)]
      .map(bloque => {
        const tm = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(bloque);
        if (!tm) return null;
        const lineas = bloque.slice(tm.index + tm[0].length).split('\n').map(l => l.trim());
        const iFuente = lineas.findIndex(l => /Tf$/.test(l));
        return { x: Number(tm[1]), y: Number(tm[2]), texto: lineas[iFuente + 1] || '' };
      })
      .filter(Boolean);

    const hora = fragmentos.find(f => f.texto.startsWith('HORA:'));
    expect(hora).toBeDefined();
    // El valor de HORA: es el fragmento de su misma linea base, a su derecha.
    const valor = fragmentos.find(f => f.y === hora.y && f.x > hora.x);
    expect(valor).toBeDefined();
    expect(valor.texto).toBe('-');
  });

  test('las tres firmas se imprimen, una por renglon de firmante', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: [],
      emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe', celular: null }
    });

    const texto = textoDelPdf(buffer);
    expect(texto).toContain('VB ADMINISTRACIÓN');
    expect(texto).toContain('ÁREA PRODUCCIÓN');
    expect(texto).toContain('VB SOLICITANTE');
  });

  test('las tres firmas van en tres columnas, no apiladas una bajo otra', async () => {
    // El fallo real: doc.text() mueve doc.y aunque se le pase una Y explicita,
    // asi que leer doc.y dentro del bucle dibujaba la segunda firma debajo de la
    // primera. Se comprueba la coordenada X de cada firma en el flujo: las tres
    // tienen que compartir la misma Y y tener X distintas.
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: [],
      emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe', celular: null }
    });
    const flujo = textoDeFlujo(extraerFlujos(buffer).join('\n'));

    // Cada texto va precedido de su matriz: "1 0 0 1 <x> <y> Tm".
    const posicionDe = (etiqueta) => {
      const i = flujo.indexOf(etiqueta);
      expect(i).toBeGreaterThan(-1);
      const antes = flujo.slice(Math.max(0, i - 200), i);
      const matrices = [...antes.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)];
      expect(matrices.length).toBeGreaterThan(0);
      const [x, y] = matrices[matrices.length - 1].slice(1).map(Number);
      return { x, y };
    };

    const admin = posicionDe('ADMINISTRACIÓN');
    const produccion = posicionDe('PRODUCCIÓN');
    const solicitante = posicionDe('SOLICITANTE');

    // Alineadas horizontalmente en la misma linea base...
    expect(produccion.y).toBe(admin.y);
    expect(solicitante.y).toBe(admin.y);
    // ...y repartidas de izquierda a derecha, no una encima de otra.
    expect(produccion.x).toBeGreaterThan(admin.x);
    expect(solicitante.x).toBeGreaterThan(produccion.x);
    // La ultima tiene que quedar dentro de la hoja, no empujada fuera.
    expect(solicitante.x).toBeLessThan(612);
  });

  test('sin cuentas bancarias el PDF igual sale', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: [],
      emisor: { nombre: '', cargo: '', celular: '' }
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('una orden sin items imprime el total sin partir lineas', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: { ...ORDEN, total: 0, igv: 0, total_igv: 0 },
      items: [], bancos: [],
      emisor: { nombre: 'Angelica Ruiz', cargo: '', celular: '' }
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('ruta GET /api/bd/ordenes/:id/pdf', () => {
  beforeEach(() => {
    responder([
      [SQL.ordenParaPDF, filas(ORDEN)],
      [SQL.itemsParaPDF, filas(...ITEMS)],
      [SQL.cuentasParaPDF, filas(...CUENTAS)],
      [SQL.emisorParaPDF, filas({ nombre: 'Angelica Ruiz', cargo: 'Jefe', celular: '987654321' })]
    ]);
  });

  test('responde el PDF como descarga, no como pagina web', async () => {
    const res = await invocar('GET', '/api/bd/ordenes/7/pdf', { params: { id: '7' } });

    expect(res.statusCode).toBe(null);   // ni json ni status: 200 implicito
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="OC-0462-2026.pdf"');
    expect(res.headers['content-length']).toBe(res.buffer.length);
    expect(res.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('rechaza un id que no es un numero', async () => {
    const res = await invocar('GET', '/api/bd/ordenes/abc/pdf', { params: { id: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.success).toBe(false);
  });

  test('avisa cuando la orden no existe en vez de bajar un PDF vacio', async () => {
    responder([[SQL.ordenParaPDF, { rows: [], rowCount: 0 }]]);
    const res = await invocar('GET', '/api/bd/ordenes/999/pdf', { params: { id: '999' } });
    expect(res.statusCode).toBe(404);
  });

  test('un fallo al leer la base responde 500 con mensaje', async () => {
    mockQuery.mockRejectedValue(new Error('caida de conexion'));
    const res = await invocar('GET', '/api/bd/ordenes/7/pdf', { params: { id: '7' } });
    expect(res.statusCode).toBe(500);
    expect(res.cuerpo.mensaje).toContain('caida');
  });

  test('la ruta esta protegida por rol', async () => {
    const res = await invocar('GET', '/api/bd/ordenes/7/pdf', { params: { id: '7' }, rol: 'invitado' });
    expect(res.statusCode).toBe(403);
  });
});

describe('datos que imprime la orden', () => {
  test('los seis campos de entrega salen recortados y vacios como null', () => {
    const campos = camposEntregaDe({
      lugar_entrega: '  Planta Principal  ',
      fecha_entrega: '2026-10-05',
      area_solicitante: '   ',
      forma_pago: 'Credito 30 dias',
      horario_recepcion: '',
      atencion: 'Almacen central'
    });
    expect(campos).toEqual([
      'Planta Principal', '2026-10-05', null, 'Credito 30 dias', null, 'Almacen central'
    ]);
  });

  test('un cuerpo vacio no rompe: los seis quedan en null', () => {
    expect(camposEntregaDe({})).toEqual([null, null, null, null, null, null]);
    expect(camposEntregaDe()).toEqual([null, null, null, null, null, null]);
  });

  test('el total de campos de entrega son seis', () => {
    // El INSERT de ordenes los lista uno a uno; si se agrega un campo al
    // formulario y no aqui, el dato no se guarda aunque se vea en pantalla.
    expect(camposEntregaDe({}).length).toBe(6);
  });
});

describe('cuentas bancarias del proveedor', () => {
  test('descarta las filas a medio llenar en vez de fallar el guardado', () => {
    const cuentas = normalizarCuentasBancarias([
      { banco: 'Interbank', tipo: 'C.C.', numero: '200-123', moneda: 'PEN', titular: 'ACME' },
      { banco: '', tipo: 'C.C.', numero: '', moneda: 'PEN', titular: 'ACME' },
      { banco: 'BCP', tipo: '', numero: '570-999', moneda: 'USD', titular: '' }
    ]);
    expect(cuentas).toHaveLength(2);
    expect(cuentas[1].banco).toBe('BCP');
  });

  test('una cuenta sin numero no se guarda', () => {
    expect(normalizarCuentasBancarias([{ banco: 'Interbank', numero: '' }])).toEqual([]);
  });

  test('una moneda desconocida se guarda como soles', () => {
    const [cuenta] = normalizarCuentasBancarias([{ banco: 'Interbank', numero: '1', moneda: 'EUR' }]);
    expect(cuenta.moneda).toBe('PEN');
  });

  test('si no llega un arreglo, no revienta el guardado del proveedor', () => {
    expect(normalizarCuentasBancarias(undefined)).toEqual([]);
    expect(normalizarCuentasBancarias('algo')).toEqual([]);
  });

  test('un arreglo vacio si borra las cuentas: es como se limpian a proposito', () => {
    // Distinguir "no vino el campo" de "vino vacio" es lo que evita que una
    // edicion sin el dato borre las cuentas del proveedor.
    expect(normalizarCuentasBancarias([])).toEqual([]);
    expect(Array.isArray([])).toBe(true);
    expect(Array.isArray(undefined)).toBe(false);
  });
});

describe('editar un proveedor y sus cuentas', () => {
  const REGLAS_PROVEEDOR = [
    [/SELECT id, nombre FROM proveedores/, filas({ id: 5, nombre: 'ACME' })],
    [/UPDATE proveedores SET nombre/, filas({ id: 5, nombre: 'ACME NUEVO' })],
    [/INSERT INTO proveedores/, filas({ id: 9, nombre: 'NUEVO SAC' })]
  ];

  const consultasHechas = () => mockQuery.mock.calls.map(c => String(c[0] || '').trim());
  const borroCuentas = () => consultasHechas().some(s => /DELETE FROM proveedor_cuentas_bancarias/i.test(s));

  beforeEach(() => {
    mockQuery.mockReset();
    responder(REGLAS_PROVEEDOR);
  });

  test('editar sin el campo deja las cuentas como estaban', async () => {
    // Una pestana con la pagina vieja, o un script, manda el cuerpo sin
    // cuentas_bancarias. Borrarlas en ese caso deja al proveedor sin datos
    // para cobrar y no se nota hasta que llega el pago.
    const res = await invocar('put', '/api/bd/proveedores/5', {
      params: { id: '5' },
      body: { nombre: 'ACME NUEVO', categoria: 'General' }
    });

    expect(res.statusCode).toBe(200);
    expect(borroCuentas()).toBe(false);
  });

  test('editar con el campo reemplaza las cuentas', async () => {
    const res = await invocar('put', '/api/bd/proveedores/5', {
      params: { id: '5' },
      body: {
        nombre: 'ACME NUEVO', categoria: 'General',
        cuentas_bancarias: [{ banco: 'Interbank', numero: '200-999', moneda: 'PEN' }]
      }
    });

    expect(res.statusCode).toBe(200);
    expect(borroCuentas()).toBe(true);
    const inserciones = consultasHechas().filter(s => /INSERT INTO proveedor_cuentas_bancarias/i.test(s));
    expect(inserciones).toHaveLength(1);
  });

  test('mandar el arreglo vacio si las borra', async () => {
    await invocar('put', '/api/bd/proveedores/5', {
      params: { id: '5' },
      body: { nombre: 'ACME NUEVO', categoria: 'General', cuentas_bancarias: [] }
    });

    expect(borroCuentas()).toBe(true);
    const inserciones = consultasHechas().filter(s => /INSERT INTO proveedor_cuentas_bancarias/i.test(s));
    expect(inserciones).toHaveLength(0);
  });
});