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
const { generarPDFOrdenCompra, nombreArchivoSeguro, PAGINA, BORDE_IMPRIMIBLE } = require('../services/pdfOrdenCompra');

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

// A nivel de modulo y no dentro de un describe: lo usan tanto las pruebas de
// las cuentas como las del formulario previo, que comprueban que imprimir no
// escriba nada en la base.
const consultasHechas = () => mockQuery.mock.calls.map(c => String(c[0] || '').trim());

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

    // Se busca el nombre completo de cada firma y no un trozo suelto: el
    // encabezado ahora trae una etiqueta "ÁREA SOLICITANTE:" que contiene la
    // palabra "SOLICITANTE", y buscar solo esa palabra tomaba la coordenada de la
    // etiqueta del encabezado en vez de la firma.
    const admin = posicionDe('VB ADMINISTRACIÓN');
    const produccion = posicionDe('ÁREA PRODUCCIÓN');
    const solicitante = posicionDe('VB SOLICITANTE');

    // Alineadas horizontalmente en la misma linea base...
    expect(produccion.y).toBe(admin.y);
    expect(solicitante.y).toBe(admin.y);
    // ...y repartidas de izquierda a derecha, no una encima de otra.
    expect(produccion.x).toBeGreaterThan(admin.x);
    expect(solicitante.x).toBeGreaterThan(produccion.x);
    // La ultima tiene que quedar dentro de la hoja, no empujada fuera.
    expect(solicitante.x).toBeLessThan(PAGINA.width);
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

describe('ruta POST /api/bd/ordenes/:id/pdf', () => {
  beforeEach(() => {
    responder([
      [SQL.ordenParaPDF, filas(ORDEN)],
      [SQL.itemsParaPDF, filas(...ITEMS)],
      [SQL.cuentasParaPDF, filas(...CUENTAS)],
      [SQL.emisorParaPDF, filas({ nombre: 'Angelica Ruiz', cargo: 'Jefe', celular: '987654321' })]
    ]);
  });

  test('responde el PDF como descarga, no como pagina web', async () => {
    const res = await invocar('POST', '/api/bd/ordenes/7/pdf', { params: { id: '7' } });

    expect(res.statusCode).toBe(null);   // ni json ni status: 200 implicito
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="OC-0462-2026.pdf"');
    expect(res.headers['content-length']).toBe(res.buffer.length);
    expect(res.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('ya no existe por GET: los datos del formulario no caben en una URL', async () => {
    expect(() => pilaDe('GET', '/api/bd/ordenes/:id/pdf')).toThrow();
  });

  test('rechaza un id que no es un numero', async () => {
    const res = await invocar('POST', '/api/bd/ordenes/abc/pdf', { params: { id: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(res.cuerpo.success).toBe(false);
  });

  test('avisa cuando la orden no existe en vez de bajar un PDF vacio', async () => {
    responder([[SQL.ordenParaPDF, { rows: [], rowCount: 0 }]]);
    const res = await invocar('POST', '/api/bd/ordenes/999/pdf', { params: { id: '999' } });
    expect(res.statusCode).toBe(404);
  });

  test('un fallo al leer la base responde 500 con mensaje', async () => {
    mockQuery.mockRejectedValue(new Error('caida de conexion'));
    const res = await invocar('POST', '/api/bd/ordenes/7/pdf', { params: { id: '7' } });
    expect(res.statusCode).toBe(500);
    expect(res.cuerpo.mensaje).toContain('caida');
  });

  test('la ruta esta protegida por rol', async () => {
    const res = await invocar('POST', '/api/bd/ordenes/7/pdf', { params: { id: '7' }, rol: 'invitado' });
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

// ============================================================================
// Hoja apaisada
//
// El PDF paso de carta vertical a A4 horizontal porque la tabla de productos es
// ancha y en vertical la descripcion se partia en tres renglones. Todo lo de
// abajo viene de esa mudanza: la hoja cambio de alto y los limites se
// recalcularon, asi que lo que antes cabia ahora puede salirse, y una fila que
// se sale no avisa: se pierde.
// ============================================================================

/** Posiciones de texto del PDF, en el espacio de la hoja (Y hacia arriba). */
function posiciones(buffer) {
  const salida = [];
  extraerFlujos(buffer).forEach((flujo, hoja) => {
    const tms = [...flujo.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)];
    for (const tm of tms) {
      const despues = flujo.slice(tm.index + tm[0].length, tm.index + tm[0].length + 900);
      const fuente = despues.match(/\/(F\d+)\s+([\d.]+)\s+Tf/);
      const arreglo = despues.match(/\[([^\]]*)\]\s*TJ/);
      if (!fuente || !arreglo) continue;
      const trozos = [...arreglo[1].matchAll(/<([0-9a-fA-F]*)>/g)]
        .map(p => Buffer.from(p[1], 'hex').toString('latin1'));
      if (!trozos.length) continue;
      salida.push({
        hoja,
        x: Number(tm[1]),
        // pdfkit abre cada bloque con "1 0 0 -1 0 <alto> cm": su Y va de arriba
        // hacia abajo. La hoja lo mide al reves.
        y: PAGINA.height - Number(tm[2]),
        texto: trozos.join(''),
        tam: Number(fuente[2])
      });
    }
  });
  return salida;
}

function hojasDe(buffer) {
  return (buffer.toString('latin1').match(/MediaBox/g) || []).length;
}

/**
 * Rectangulos del PDF, en el espacio de la hoja (Y hacia arriba).
 *
 * Hace falta para lo del recuadro de datos: decir que el texto no lo toca exige
 * saber donde esta el borde, y los bordes son trazos, no texto. Sin esto, la
 * unica forma de comprobarlo seria medir el texto y suponer que el recuadro esta
 * donde se le pidio, que es justo lo que hay que revisar.
 */
function rectangulos(buffer) {
  const salida = [];
  extraerFlujos(buffer).forEach((flujo, hoja) => {
    for (const m of flujo.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re/g)) {
      salida.push({
        hoja,
        x: Number(m[1]),
        // Ojo: el texto sale de un bloque con la Y reflejada y hay que darla
        // vuelta (PAGINA.height - tm.y), pero el rectangulo ya viene medido
        // desde arriba. Darle la vuelta tambien al rectangulo lo deja a media
        // hoja y la comprobacion de rozamiento no encuentra nada que medir.
        y: Number(m[2]),
        w: Number(m[3]),
        h: Number(m[4])
      });
    }
  });
  return salida;
}

/** El recuadro de los datos de arriba: el primer rectangulo ancho de la hoja. */
function recuadroDeDatos(buffer) {
  // Es el primero porque se dibuja antes que las tablas. Agarrar "el unico con
  // alto entre 20 y 160" no serviria: una fila de producto con la descripcion
  // larga entra en esa misma ventana yeria un segundo candidato.
  const anchos = rectangulos(buffer).filter(r => r.hoja === 0 && r.w > PAGINA.width * 0.8);
  expect(anchos.length).toBeGreaterThan(0);
  return anchos.reduce((a, r) => (r.y < a.y ? r : a));
}

describe('hoja A4 apaisada', () => {
  test('la hoja sale apaisada y de tamano A4', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe', celular: '987654321' }
    });

    // A4 horizontal son 841.89 x 595.28 puntos. La caja medial tiene que decir
    // eso, no "letter": un MediaBox distinto significa que la maqueta esta
    // calculada para una hoja y el papel es otra.
    const cajas = [...buffer.toString('latin1').matchAll(/MediaBox \[([\d. ]+)\]/g)].map(m => m[1].trim());
    expect(cajas.length).toBeGreaterThan(0);
    for (const caja of cajas) {
      const [x0, y0, x1, y1] = caja.split(/\s+/).map(Number);
      expect(x1 - x0).toBeCloseTo(841.89, 1);
      expect(y1 - y0).toBeCloseTo(595.28, 1);
    }
  });

  test('la orden de ejemplo entra en una sola hoja', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe de almacen', celular: '987654321' }
    });
    expect(hojasDe(buffer)).toBe(1);
  });

  test('nada se sale del area que una impresora respeta', async () => {
    // Esta es la regresion que si no se detecta no se ve: una fila dibujada mas
    // abajo del borde no lanza error, simplemente no aparece en el papel. La
    // pagina apaisada tiene 57 puntos menos de alto, asi que el margen que
    // antes alcanzaba deja de alcanzar.
    const itemsLargos = Array.from({ length: 6 }, (_, i) => ({
      descripcion: `BOTELLA PET 1L TRANSPARENTE PARA AGUA MINERAL SIN TAPA, ENVASADO EN CAJA DE 24 UNIDADES (producto ${i + 1})`,
      unidad: 'UND', cantidad: (i + 1) * 24, precio: 1.35 + i, subtotal: (i + 1) * 24 * (1.35 + i)
    }));
    const buffer = await generarPDFOrdenCompra({
      orden: {
        ...ORDEN,
        lugar_entrega: 'Planta Principal - Corporacion Belcen, Av. Los Frutales 1450',
        atencion: 'Sr. Juan Perez Perez, jefe de almacen de la planta principal'
      },
      items: itemsLargos,
      bancos: CUENTAS,
      emisor: { nombre: 'Angelica Ruiz Ramirez', cargo: 'Jefe de Compras', celular: '987654321' }
    });

    const fuera = posiciones(buffer).filter(p =>
      p.x < BORDE_IMPRIMIBLE || p.x > PAGINA.width - BORDE_IMPRIMIBLE ||
      p.y < BORDE_IMPRIMIBLE || p.y + p.tam * 1.2 > PAGINA.height - BORDE_IMPRIMIBLE
    );
    expect(fuera.map(f => `${f.hoja + 1}: ${f.texto}`)).toEqual([]);
  });

  test('las etiquetas del encabezado caen alineadas entre columnas', async () => {
    // Con cuatro columnas, si cada una avanzara su Y por su cuenta, en cuanto un
    // valor envuelve (un correo largo, un nombre de proveedor) esa columna se
    // correria y sus etiquetas dejarían de alinearse con las de al lado. En un
    // papel que van a firmar tres personas, esas filas torcidas se notan.
    const buffer = await generarPDFOrdenCompra({
      orden: { ...ORDEN, email: 'compras.de.ventas.encorporacion@cementosdelsur.com.pe' },
      items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe de almacen', celular: '987654321' }
    });
    const pos = posiciones(buffer);

    // Las cuatro etiquetas de la primera fila comparten linea base.
    const etiquetas = ['PROVEEDOR:', 'E-MAIL:', 'CARGO:', 'ÁREA SOLICITANTE:'];
    const fila = etiquetas.map(t => pos.find(p => p.texto.startsWith(t)));
    for (const e of fila) expect(e).toBeDefined();
    const ys = new Set(fila.map(e => Math.round(e.y * 10) / 10));
    expect(ys.size).toBe(1);
  });

  test('una etiqueta larga no se parte en dos lineas', async () => {
    // "HORARIO RECEPCIÓN:" no entraba en la caja de etiqueta fija y se partia,
    // dejando la etiqueta desalineada de su valor.
    const pos = posiciones(await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: '', celular: '' }
    }));
    expect(pos.some(p => p.texto.startsWith('HORARIO RECEPCIÓN:'))).toBe(true);
    expect(pos.some(p => p.texto.trim() === 'RECEPCIÓN:')).toBe(false);
  });

  test('el recuadro de datos no toca el texto', async () => {
    // Este es el defecto que se ve al imprimir: el texto arrancaba en el mismo
    // punto que el borde izquierdo y la altura de mayuscula de la primera fila
    // caia justo sobre la linea de arriba. El recuadro no se leia como un marco
    // sino como una linea de texto atravesada por el borde.
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe de almacen', celular: '987654321' }
    });
    const marco = recuadroDeDatos(buffer);
    const ETIQUETAS = ['PROVEEDOR:', 'RUC:', 'ATENCIÓN:', 'E-MAIL:', 'CARGO:', 'ÁREA SOLICITANTE:', 'HORARIO RECEPCIÓN:'];
    const filas = posiciones(buffer).filter(p => p.hoja === 0 && ETIQUETAS.some(e => p.texto.startsWith(e)));
    expect(filas.length).toBe(ETIQUETAS.length);

    // Lo que se mide no es la linea base sino la caja de la letra: la base
    // queda 5,4 puntos mas abajo que la mayuscula, y con ella de referencia
    // la comprobacion del borde de arriba daria un margen que no existe.
    const ALTURA_MAYUSCULA = 0.718;
    const DESCENDEDOR = 0.207;
    const roces = filas.filter(p => {
      const techo = p.y - p.tam * ALTURA_MAYUSCULA;
      const suelo = p.y + p.tam * DESCENDEDOR;
      return p.x < marco.x + 4 || p.x > marco.x + marco.w - 4 ||
        techo < marco.y + 4 || suelo > marco.y + marco.h - 4;
    });
    expect(roces.map(p => `${p.texto} en ${p.x.toFixed(1)}/${p.y.toFixed(1)}`)).toEqual([]);
  });

  test('los renglones del bloque de datos se separan', async () => {
    // Con la fila de 9,07 puntos para una linea de 8,67 sobraban 0,4: entre la
    // cola de una letra y la mayuscula de la de abajo quedaban 0,75 mm y los
    // renglones se leian pegados.
    const pos = posiciones(await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: 'Jefe de almacen', celular: '987654321' }
    }));
    const renglones = ['PROVEEDOR:', 'RUC:', 'ATENCIÓN:', 'CEL:']
      .map(e => pos.find(p => p.texto === e && p.x < 100));
    expect(renglones.every(Boolean)).toBe(true);

    for (let i = 1; i < renglones.length; i++) {
      const separacion = renglones[i].y - renglones[i - 1].y;
      // La primera fila mide mas que las otras porque su valor envuelve, asi que
      // solo se comparan las filas de una linea.
      expect(separacion).toBeGreaterThan(12);
    }
  });
});

describe('condiciones del pie', () => {
  const CONDICIONES = [
    'CONDICIONES:',
    'Documentación:',
    'Calidad:',
    'Despacho:',
    'Precio:'
  ];

  test('son las condiciones del documento, no las de antes', async () => {
    const pos = posiciones(await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: 'Jefe de almacen', celular: '987654321' }
    }));
    const todo = pos.map(p => p.texto).join(' ');
    for (const cond of CONDICIONES) expect(todo).toContain(cond);

    // "Calidad y Despacho:" era una sola linea que mezclaba dos cosas distintas:
    // una es motivo de rechazo por calidad de la mercaderia, la otra por fecha y
    // lugar de envio. Separadas se puede negar una sin la otra.
    expect(todo).not.toContain('Calidad y Despacho:');
    expect(todo).not.toContain('CONDICIONES GENERALES:');
  });

  test('Calidad lleva sus tres parrafos, los dos ultimos sangrados', async () => {
    const pos = posiciones(await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: 'Jefe de almacen', celular: '987654321' }
    }));
    const etiqueta = pos.find(p => p.texto.trim() === 'Calidad:');
    const continuaciones = pos.filter(p =>
      p.texto.startsWith('La mercadería enviada de menos o más') ||
      p.texto.startsWith('La mercadería enviada que se encuentre en mal estado'));
    expect(etiqueta).toBeDefined();
    expect(continuaciones).toHaveLength(2);

    // Los tres parrafos de Calidad, con el del medio y el ultimo un poco mas
    // adentro. Sin sangria se leen como condiciones nuevas que abren y cierran
    // con su propio punto.
    const documentacion = pos.find(p => p.texto.trim() === 'Documentación:');
    for (const cont of continuaciones) expect(cont.x).toBeGreaterThan(documentacion.x);
  });

  test('las condiciones no terminan con los cuatro textos que se corrigieron', async () => {
    // Erratas del documento: "Lotiz.", "al costato", "El envío" y "lugar y fecha
    // no establecidas". Van en clauses de un papel que firma el proveedor, asi que
    // la palabra mal escrita viaja con el pedido.
    const pos = posiciones(await generarPDFOrdenCompra({
      orden: ORDEN, items: ITEMS, bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: 'Jefe de almacen', celular: '987654321' }
    }));
    const todo = pos.map(p => p.texto).join(' ');
    expect(todo).toContain('lugar y fecha no establecidos');
    expect(todo).not.toContain('no establecidas');
    expect(todo).not.toContain('El envió');
  });
});

describe('partidas de pagina', () => {
  const muchosItems = (n) => Array.from({ length: n }, (_, i) => ({
    descripcion: `TAPA ROSCA 38mm PARA FRASCO DE VIDRIO COLOR BLANCO (producto ${i + 1})`,
    unidad: 'UND', cantidad: (i + 1) * 12, precio: 1.5 + i * 0.1,
    subtotal: +((i + 1) * 12 * (1.5 + i * 0.1)).toFixed(2)
  }));

  test('una orden larga se parte y no se pierde ninguna linea', async () => {
    const items = muchosItems(30);
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items, bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: '', celular: '' }
    });

    expect(hojasDe(buffer)).toBeGreaterThan(1);
    // El fallo original: dibujar de mas alla del borde y perder el rabo. Se
    // comprueba que estan TODAS las lineas, no que el PDF exista.
    const texto = textoDelPdf(buffer);
    for (const item of items) {
      expect(texto).toContain(`producto ${item.descripcion.match(/producto (\d+)/)[1]}`);
    }
    // Y que los totales siguen al final, que es donde el usuario los mira.
    expect(texto).toContain('TOTALES');
  });

  test('cada hoja repite la cabecera de la tabla', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: muchosItems(30), bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: '', celular: '' }
    });

    const porHoja = new Map();
    for (const p of posiciones(buffer)) {
      if (!porHoja.has(p.hoja)) porHoja.set(p.hoja, []);
      porHoja.get(p.hoja).push(p.texto);
    }
    const hojas = [...porHoja.keys()].sort((a, b) => a - b);
    expect(hojas.length).toBeGreaterThan(1);
    for (const h of hojas) {
      expect(porHoja.get(h).join(' ')).toContain('DESCRIPCIÓN');
    }
  });

  test('las firmas quedan en la ultima hoja y dentro del papel', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: muchosItems(30), bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: '', celular: '' }
    });
    const pos = posiciones(buffer);
    const ultimaHoja = Math.max(...pos.map(p => p.hoja));
    const firmas = pos.filter(p => p.hoja === ultimaHoja && p.texto.includes('ADMINISTRACIÓN'));
    expect(firmas.length).toBeGreaterThan(0);
    expect(firmas[0].y).toBeGreaterThan(BORDE_IMPRIMIBLE);
  });

  test('el pie numera las hojas y no las rompe', async () => {
    const buffer = await generarPDFOrdenCompra({
      orden: ORDEN, items: muchosItems(30), bancos: CUENTAS,
      emisor: { nombre: 'Angelica', cargo: '', celular: '' }
    });
    const texto = textoDelPdf(buffer);
    expect(texto).toMatch(/P.gina 1 de \d+/);
    // Cada pie agregaba una hoja en blanco porque caia dentro del margen
    // inferior, que es donde pdfkit decide partir la hoja.
    const total = hojasDe(buffer);
    const esperadas = texto.match(/P.gina \d+ de (\d+)/g) || [];
    const ultimaHoja = Math.max(...posiciones(buffer).map(p => p.hoja)) + 1;
    expect(total).toBe(ultimaHoja);
    expect(esperadas).toHaveLength(total);
  });
});

// ============================================================================
// Datos que se escriben en el PDF sin guardarse
// ============================================================================

describe('formulario previo a imprimir', () => {
  beforeEach(() => {
    responder([
      [SQL.ordenParaPDF, filas(ORDEN)],
      [SQL.itemsParaPDF, filas(...ITEMS)],
      [SQL.cuentasParaPDF, filas(...CUENTAS)],
      [SQL.emisorParaPDF, filas({ nombre: 'Angelica Ruiz', cargo: 'Jefe', celular: '987654321' })]
    ]);
  });

  test('lo que escribe el formulario llega al PDF', async () => {
    const res = await invocar('POST', '/api/bd/ordenes/7/pdf', {
      params: { id: '7' },
      body: {
        entrega: { lugar_entrega: 'Almacen de Productos Terminados', forma_pago: 'Credito 45 dias' },
        emisor: { nombre: 'Angelica Ruiz', cargo: 'Jefe de Compras', celular: '999888777' },
        cuentas: [{ banco: 'BBVA', tipo: 'C.C. Soles', numero: '000-999', moneda: 'PEN', titular: 'ACME S.A.C.' }]
      }
    });

    const texto = textoDelPdf(res.buffer);
    expect(texto).toContain('Almacen de Productos Terminados');
    expect(texto).toContain('Credito 45 dias');
    expect(texto).toContain('Jefe de Compras');
    expect(texto).toContain('999888777');
    expect(texto).toContain('BBVA');
    expect(texto).toContain('000-999');
  });

  test('un campo vacio no borra lo que la orden ya tenia guardado', async () => {
    // El formulario es para rellenar huecos. Si el usuario abre el PDF, no
    // cambia un campo y lo deja en blanco, ese dato no debe desaparecer: se
    // perderia informacion real de la orden por haber tocado el formulario.
    const res = await invocar('POST', '/api/bd/ordenes/7/pdf', {
      params: { id: '7' },
      body: {
        entrega: { lugar_entrega: 'Almacen Nuevo', forma_pago: '   ' },
        emisor: { nombre: 'Angelica Ruiz', cargo: '' }
      }
    });

    const texto = textoDelPdf(res.buffer);
    expect(texto).toContain('Almacen Nuevo');
    expect(texto).toContain('Credito 30 dias');   // el de la orden, no el vacio
    expect(texto).toContain('Jefe');             // cargo guardado del usuario
  });

  test('generar el PDF no escribe nada en la base', async () => {
    await invocar('POST', '/api/bd/ordenes/7/pdf', {
      params: { id: '7' },
      body: { entrega: { lugar_entrega: 'X' }, emisor: { cargo: 'Y' }, cuentas: [{ banco: 'B', numero: '1' }] }
    });

    // Lo unico que debe tocar la base son lecturas. Un UPDATE aqui seria una
    // orden que cambia sola cada vez que alguien la imprime.
    const escrituras = consultasHechas()
      .filter(s => /^(INSERT|UPDATE|DELETE)/i.test(s));
    expect(escrituras).toEqual([]);
  });

  test('sin datos en el cuerpo sale el PDF igual, con lo que hay guardado', async () => {
    const res = await invocar('POST', '/api/bd/ordenes/7/pdf', { params: { id: '7' } });
    expect(res.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(textoDelPdf(res.buffer)).toContain('Planta Principal');
  });

  test('GET /datos-oc avisa de lo que falta', async () => {
    responder([
      [SQL.ordenParaPDF, filas({ ...ORDEN, lugar_entrega: null, forma_pago: null, atencion: null })],
      [SQL.itemsParaPDF, filas(...ITEMS)],
      [SQL.cuentasParaPDF, filas()],
      [SQL.emisorParaPDF, filas({ nombre: '', cargo: null, celular: null })]
    ]);
    const res = await invocar('GET', '/api/bd/ordenes/7/datos-oc', { params: { id: '7' } });

    expect(res.statusCode).toBe(200);
    const { faltantes } = res.cuerpo.datos;
    const etiquetas = faltantes.map(f => f.etiqueta);
    expect(etiquetas).toContain('Lugar de entrega');
    expect(etiquetas).toContain('Forma de pago');
    expect(etiquetas).toContain('Cuentas bancarias del proveedor');
    expect(etiquetas).toContain('Cargo');
  });

  test('no avisa de la atencion si el proveedor tiene contacto', async () => {
    // La atencion cae al contacto del proveedor, asi que avisar "falta atencion"
    // en una orden que si va a imprimir el contacto es hacer perder la
    // confianza en el aviso: a la segunda vez el usuario deja de leerlo.
    const res = await invocar('GET', '/api/bd/ordenes/7/datos-oc', { params: { id: '7' } });
    const etiquetas = res.cuerpo.datos.faltantes.map(f => f.etiqueta);
    expect(etiquetas).not.toContain('Atención a');
  });
});