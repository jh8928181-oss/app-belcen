/**
 * Armado del PDF de la orden de compra.
 *
 * Estetica equivalente a la que se armo antes con ReportLab: carta, margenes
 * angostos, encabezado en dos columnas (proveedor a la izquierda, emisor a la
 * derecha), tabla de productos con la fila de totales al pie, cuentas bancarias
 * del proveedor, condiciones y tres firmas.
 *
 * Dos decisiones que no son esteticas:
 *
 * 1. El PDF no recalcula importes. Todo sale de la orden guardada: total es la
 *    base imponible y total_igv es el total final. Confundirlos cambia el monto
 *    que el proveedor lee. El IGV por linea si se calcula, porque la base no lo
 *    guarda, y se reparte con repartirIgv() para que la columna cuadre.
 *
 * 2. "FEC. ENTREGA" y "AREA SOLICITANTE" son constantes de la orden, no de cada
 *    linea, asi que van una vez en la cabecera. Repetirlas en cada fila como en
 *    el diseno original llenaba la tabla de columnas iguales sin agregar un solo
 *    dato.
 *
 * pdfkit 0.20 exporta el constructor como el modulo mismo, no como
 * .Document como en las versiones anteriores.
 *
 * pdfkit no interpreta etiquetas de HTML: doc.text() con '<b>' y '<br/>' los
 * escribe tal cual en el papel. Las negritas se hacen cambiando de fuente con
 * continued:true y los saltos de linea, con un doc.text() por renglon.
 */

const PDFDocument = require('pdfkit');
const { datosMoneda, repartirIgv } = require('./ocPdfDatos');

const CM = 28.3465; // 1 cm en puntos, que es la unidad en la que trabaja pdfkit
const LETTER_ANCHO = 612; // 8.5 pulgadas, el ancho de carta segun pdfkit

const MARGEN = 1.0 * CM;
const ANCHO = LETTER_ANCHO - 2 * MARGEN; // ancho util
const MITAD = ANCHO / 2;
const X_IZQUIERDA = MARGEN;
const X_DERECHA = MARGEN + MITAD;
const ANCHO_ETIQUETA = 3.1 * CM;
// Holgura entre el valor de una columna y la etiqueta de la siguiente. Sin ella
// las dos mitadas se tocan justo y un correo largo del proveedor se junta con
// "EMITIDO POR:" sin ningun espacio en blanco de por medio.
const HOLGURA = 0.35 * CM;

const AZUL_OSCURO = '#1A365D';
const AZUL = '#2B6CB0';
const GRIS_OSCURO = '#4A5568';
const GRIS = '#B0B0B0';
const ROJO = '#C53030';

// Razon social que sale impresa. Es una constante y no un dato de la base: si
// hay que cambiarla, se cambia aqui.
const RAZON_SOCIAL = 'CORPORACION DON LALO SAC';

// Anchos de la tabla de productos, en cm. Suman 18.2 de los 19.6 utiles.
const ANCHOS_PRODUCTOS = [4.7, 1.1, 1.1, 1.2, 1.8, 1.5, 1.8].map(c => c * CM);
// Anchos de la tabla de cuentas, en cm. Suman 18.0 de los 19.6 utiles.
const ANCHOS_BANCOS = [2.6, 4.8, 4.2, 2.0, 4.4].map(c => c * CM);

// Condiciones que dependen de datos de la orden. Cada una dice de donde sale el
// valor y si es fecha, porque no todas lo son y aplicarles a todas un
// formateador de fecha las dejaria en diez caracteres.
const CONDICIONES = [
  { etiqueta: 'Lugar de entrega', campo: 'lugar_entrega' },
  { etiqueta: 'Fecha de entrega', campo: 'fecha_entrega', fecha: true },
  { etiqueta: 'Área solicitante', campo: 'area_solicitante' },
  { etiqueta: 'Forma de pago', campo: 'forma_pago' },
  { etiqueta: 'Horario de recepción', campo: 'horario_recepcion' }
];

const CONDICIONES_FIJAS = [
  '<b>Documentación:</b> Todo pedido debe llegar con su respectiva Orden de Compra, Guía de Remisión, Factura, Certificado de Calidad y Hojas de Seguridad.',
  '<b>Calidad y Despacho:</b> Mercadería fuera de especificaciones, en mal estado o fuera de fecha/lugar no será recibida en nuestros almacenes.',
  '<b>Precio:</b> No estamos obligados a pagar un precio mayor al estipulado en esta orden.'
];

const FIRMAS = ['VB ADMINISTRACIÓN', 'ÁREA PRODUCCIÓN', 'VB SOLICITANTE'];

/** Formatea un importe con separador de miles y dos decimales. */
function fmtMoneda(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Cantidad sin decimales cuando es entera: "100" y no "100.00". */
function fmtCantidad(valor) {
  const n = Number(valor) || 0;
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Fecha a dd/mm/aaaa, sin girar el dia.
 *
 * postgres manda las columnas date y timestamp como objetos Date, no como
 * texto, y un Date no se puede recortar con slice(): su toString() empieza con
 * "Thu Oct 01". Ademas se usan las partes locales a proposito: las columnas son
 *_naivas_ (no llevan zona), asi que el valor que trae el driver ya es la hora
 * de pared que se guardo, y pasarlo por America/Lima lo correria un dia
 * entero si el servidor corre en UTC.
 */
function fmtFecha(valor) {
  if (!valor) return '';
  if (valor instanceof Date) {
    if (isNaN(valor.getTime())) return '';
    return `${String(valor.getDate()).padStart(2, '0')}/${String(valor.getMonth() + 1).padStart(2, '0')}/${valor.getFullYear()}`;
  }
  const s = String(valor).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/**
 * Hora del timestamp de la base. Tambien en partes locales, por lo mismo que
 * fmtFecha: el timestamp es naive y ya viene en la hora de pared guardada.
 */
function fmtHora(valor) {
  if (!valor) return '';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function valorO(campo) {
  const v = campo === null || campo === undefined ? '' : String(campo).trim();
  return v || '-';
}

/** Elimina los caracteres que rompen un nombre de archivo. */
function nombreArchivoSeguro(texto, respaldo) {
  const limpio = String(texto || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  // Siempre cadena: el resultado se concatena en el Content-Disposition y un
  // numero suelto ahi se veria igual pero no es del mismo tipo que el resto.
  return limpio || String(respaldo);
}

/**
 * @param {{orden:object, items:Array, bancos:Array, emisor:object}} datos
 * @returns {Promise<Buffer>} El PDF completo.
 */
async function generarPDFOrdenCompra(datos) {
  const { orden, items, bancos, emisor } = datos;
  const doc = new PDFDocument({ size: 'letter', margin: MARGEN });
  const trozos = [];
  doc.on('data', c => trozos.push(c));
  const terminado = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);
  });

  const { simbolo } = datosMoneda(orden.moneda);

  // El IGV de las tres columnas tiene que ser el mismo numero. Se usa el que
  // guardo la orden y, si no viniera (ordenes viejas, o una alta que lo dejo
  // vacio), se deriva del total y la tasa: imprimir 0.00 junto a un total de
  // 3,815.06 es una orden que el proveedor devuelve.
  const totalBase = Number(orden.total) || 0;
  const igvOrden = Number.isFinite(Number(orden.igv)) && orden.igv !== null && orden.igv !== ''
    ? Number(orden.igv)
    : Math.round(totalBase * (Number(orden.igv_pct) || 0)) / 100;

  // ---- Encabezado ----
  doc.font('Helvetica-Bold').fontSize(13)
    .text(RAZON_SOCIAL, MARGEN, doc.y, { width: ANCHO, align: 'center' })
    .text(orden.tipo === 'OS' ? 'ORDEN DE SERVICIO' : 'ORDEN DE COMPRA', { align: 'center' })
    .fontSize(11).fillColor(ROJO).text(`N° ${orden.numero}`, { align: 'center' })
    .fillColor('#000000');
  doc.y += 0.6 * CM;

  // ---- Bloque de dos columnas ----
  const izquierda = [
    ['PROVEEDOR:', valorO(orden.proveedor_nombre_actual || orden.proveedor_nombre)],
    ['RUC:', valorO(orden.ruc)],
    ['ATENCIÓN:', valorO(orden.atencion || orden.contacto)],
    ['CEL:', valorO(orden.telefono)],
    ['E-MAIL:', valorO(orden.email)],
    ['FORMA DE PAGO:', valorO(orden.forma_pago)],
    ['MONEDA:', `${simbolo} ${valorO(orden.moneda)}`]
  ];
  const derecha = [
    ['EMITIDO POR:', valorO(emisor && emisor.nombre)],
    ['CARGO:', valorO(emisor && emisor.cargo)],
    ['CEL:', valorO(emisor && emisor.celular)],
    ['FECHA:', fmtFecha(orden.fecha_orden || orden.fecha_registro)],
    ['HORA:', valorO(fmtHora(orden.fecha_registro))],
    ['HORARIO RECEPCIÓN:', valorO(orden.horario_recepcion)]
  ];

  const yBloque = doc.y;
  const yFin = Math.max(
    escribirColumna(doc, izquierda, X_IZQUIERDA, yBloque),
    escribirColumna(doc, derecha, X_DERECHA, yBloque)
  );
    // El recuadro se dibuja al final para que el texto quede encima del borde.
  doc.save().lineWidth(1).strokeColor(GRIS)
    .rect(MARGEN, yBloque, ANCHO, yFin - yBloque + 0.15 * CM).stroke().restore();
  doc.y = yFin + 0.55 * CM;

  // ---- Tabla de productos ----
  const igvPorLinea = repartirIgv(items, orden.igv_pct, igvOrden);
  const filas = items.map((it, idx) => {
    const sub = Number(it.subtotal) || 0;
    const igv = igvPorLinea[idx] || 0;
    return {
      celdas: [
        { texto: String(it.descripcion || ''), al: 'left', envolver: true },
        { texto: fmtCantidad(it.cantidad), al: 'center' },
        { texto: String(it.unidad || ''), al: 'center' },
        { texto: fmtMoneda(it.precio), al: 'center' },
        { texto: fmtMoneda(sub), al: 'center' },
        { texto: fmtMoneda(igv), al: 'center' },
        { texto: fmtMoneda(sub + igv), al: 'center' }
      ]
    };
  });

  // La fila de totales sale de la orden, no de la suma de las lineas: la orden
  // ya guardo el IGV redondeado sobre el total y ese es el numero que se paga.
  filas.push({
    total: true,
    celdas: [
      { texto: 'TOTALES', al: 'left' },
      { texto: '' }, { texto: '' }, { texto: '' },
      { texto: `${simbolo} ${fmtMoneda(totalBase)}` },
      { texto: `${simbolo} ${fmtMoneda(igvOrden)}` },
      { texto: `${simbolo} ${fmtMoneda(orden.total_igv)}` }
    ]
  });

  dibujarTabla(doc, {
    cabeceras: ['DESCRIPCIÓN', 'CANT.', 'UM', 'PU', 'SUB TOTAL', 'IGV', 'PT'],
    filas,
    anchos: ANCHOS_PRODUCTOS,
    encabezado: AZUL_OSCURO
  });

  doc.font('Helvetica').fontSize(6)
    .text(`IGV aplicado: ${Number(orden.igv_pct) || 0}%`, MARGEN, doc.y + 0.15 * CM, { width: ANCHO, align: 'right' });
  doc.y += 0.55 * CM;

  // ---- Cuentas bancarias ----
  doc.font('Helvetica-Bold').fontSize(7.5).text('CUENTAS BANCARIAS AUTORIZADAS PARA PAGO:', MARGEN, doc.y, { width: ANCHO });
  doc.y += 0.25 * CM;
  if (bancos.length) {
    dibujarTabla(doc, {
      cabeceras: ['BANCO', 'TIPO DE CUENTA', 'NÚMERO DE CUENTA', 'MONEDA', 'TITULAR'],
      filas: bancos.map(c => ({
        celdas: [
          { texto: valorO(c.banco), al: 'left' },
          { texto: valorO(c.tipo) },
          { texto: valorO(c.numero) },
          { texto: `${datosMoneda(c.moneda).simbolo} ${valorO(c.moneda)}` },
          { texto: valorO(c.titular), al: 'left' }
        ]
      })),
      anchos: ANCHOS_BANCOS,
      encabezado: GRIS_OSCURO
    });
  } else {
    doc.font('Helvetica-Oblique').fontSize(7).fillColor('#555555')
      .text('El proveedor no tiene cuentas bancarias registradas.', MARGEN, doc.y, { width: ANCHO });
    doc.fillColor('#000000');
  }
  doc.y += 0.55 * CM;

  // ---- Condiciones generales ----
  doc.font('Helvetica-Bold').fontSize(6).text('CONDICIONES GENERALES:', MARGEN, doc.y, { width: ANCHO });
  doc.font('Helvetica').fontSize(6);
  for (const cond of CONDICIONES) {
    const crudo = String(orden[cond.campo] || '').trim();
    if (!crudo) continue;
    doc.font('Helvetica-Bold').text(`${cond.etiqueta}: `, MARGEN, doc.y, { width: ANCHO, continued: true });
    doc.font('Helvetica').text(`${cond.fecha ? fmtFecha(crudo) : crudo}\n`, { width: ANCHO });
  }
  for (const linea of CONDICIONES_FIJAS) {
    const corte = linea.indexOf('</b>');
    doc.font('Helvetica-Bold').text(linea.slice(0, corte + 4).replace(/<\/?b>/g, ''), MARGEN, doc.y, { width: ANCHO, continued: true });
    doc.font('Helvetica').text(linea.slice(corte + 4) + '\n', { width: ANCHO });
  }
  doc.y += 0.8 * CM;

  // ---- Firmas ----
  // La linea base se calcula una sola vez. text() mueve doc.y aunque se le
  // pase una Y explicita, asi que leer doc.y dentro del bucle apilaba las tres
  // firmas en cascada en vez de alinearlas.
  const yFirmas = doc.y;
  const anchoTercio = ANCHO / FIRMAS.length;
  FIRMAS.forEach((firma, i) => {
    const x = MARGEN + i * anchoTercio;
    // El ancho lleva 4 puntos de resto para que el texto de una firma no
    // invada el hueco de la siguiente.
    const ancho = anchoTercio - 4;
    doc.font('Helvetica').fontSize(7).text('_'.repeat(20), x, yFirmas, { width: ancho, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(7).text(firma, x, yFirmas + 0.5 * CM, { width: ancho, align: 'center' });
  });

  doc.end();
  return terminado;
}

/**
 * Escribe una etiqueta en negrita y su valor al lado, en una sola columna del
 * bloque de encabezado.
 * @returns {number} La Y de debajo del ultimo par.
 */
function escribirColumna(doc, pares, x, yInicio) {
  const anchoValor = MITAD - ANCHO_ETIQUETA - HOLGURA;
  const altoMinimo = 0.32 * CM;
  let y = yInicio;
  for (const [etiqueta, valor] of pares) {
    doc.font('Helvetica-Bold').fontSize(7.5).text(etiqueta, x, y, {
      width: ANCHO_ETIQUETA, align: 'left', lineBreak: false
    });
    const altoEtiqueta = doc.heightOfString(etiqueta, { width: ANCHO_ETIQUETA });
    doc.font('Helvetica').text(valor, x + ANCHO_ETIQUETA, y, { width: anchoValor, align: 'left' });
    const altoValor = doc.heightOfString(valor, { width: anchoValor });
    y += Math.max(altoEtiqueta, altoValor, altoMinimo);
  }
  return y;
}

/**
 * Dibuja una tabla con celdas de alto variable (por texto que envuelve) y deja
 * doc.y en la fila siguiente.
 */
function dibujarTabla(doc, { cabeceras, filas, anchos, encabezado }) {
  const x = MARGEN;
  const anchoTotal = anchos.reduce((a, b) => a + b, 0);
  const altoCabecera = 0.6 * CM;
  let y = doc.y;

  doc.save().rect(x, y, anchoTotal, altoCabecera).fillColor(encabezado).fill().restore();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#FFFFFF');
  let cx = x;
  cabeceras.forEach((h, i) => {
    doc.text(h, cx, y + 0.16 * CM, { width: anchos[i], align: 'center' });
    cx += anchos[i];
  });
  doc.fillColor('#000000');
  y += altoCabecera;

  for (const fila of filas) {
    const esTotal = !!fila.total;
    // El alto lo marca la celda que mas texto tenga, para que ninguna fila
    // se corte por arriba de su contenido.
    let alto = esTotal ? 0.6 * CM : 0.5 * CM;
    if (!esTotal) {
      for (let i = 0; i < fila.celdas.length; i++) {
        if (fila.celdas[i].envolver) {
          alto = Math.max(alto, doc.heightOfString(fila.celdas[i].texto, { width: anchos[i] - 0.2 * CM }) + 0.3 * CM);
        }
      }
    }

    if (esTotal) {
      doc.save().rect(x, y, anchoTotal, alto).fillColor(AZUL).fill().restore();
      doc.fillColor('#FFFFFF');
    }
    doc.font(esTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5);
    cx = x;
    for (let i = 0; i < fila.celdas.length; i++) {
      const celda = fila.celdas[i];
      doc.text(celda.texto, cx + 0.1 * CM, y + 0.15 * CM, {
        width: anchos[i] - 0.2 * CM,
        align: celda.al || 'center',
        ellipsis: !celda.envolver,
        lineBreak: false
      });
      cx += anchos[i];
    }
    if (esTotal) doc.fillColor('#000000');

    doc.save().lineWidth(0.5).strokeColor(GRIS).rect(x, y, anchoTotal, alto).stroke();
    cx = x;
    for (const ancho of anchos.slice(0, -1)) {
      cx += ancho;
      doc.moveTo(cx, y).lineTo(cx, y + alto).stroke();
    }
    doc.restore();
    y += alto;
  }

  doc.y = y;
  return y;
}

module.exports = {
  generarPDFOrdenCompra, fmtMoneda, fmtFecha, fmtHora, fmtCantidad,
  nombreArchivoSeguro, RAZON_SOCIAL
};