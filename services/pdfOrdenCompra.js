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

/**
 * A4 horizontal: 841.89 x 595.28 puntos (29.7 x 21 cm).
 *
 * Se pone la hoja apaisada porque el formato de la OC es una tabla ancha: en
 * vertical la descripcion de un producto tinha que partirse en tres renglones y
 * la tabla de cuentas parecia un recibo de supermercado. Horizontal entra con
 * holgura y la letra se puede agrandar.
 *
 * El alto es el precio. A4 vertical dejaba 735 puntos utiles y apaisado deja
 * 538, asi que todo lo que se ahorre en lo alto es lo que decide si la orden
 * cabe en una hoja o se parte en dos. Por eso el bloque de datos va en cuatro
 * columnas y las tablas se reparten el ancho sobrante en vez de usar medidas
 * sueltas.
 */
const PAGINA = { width: 841.89, height: 595.28 };

const MARGEN = 1.0 * CM;
const ANCHO = PAGINA.width - 2 * MARGEN; // ancho util: 785.2
const ANCHO_ETIQUETA = 2.9 * CM;
const TAMANO_DATOS = 7.5;
// 0,32 cm eran 9,07 puntos para una linea de 8,67: sobraban 0,4. Entre la cola
// de una letra y la mayuscula de la de abajo quedaban 0,75 mm, y los renglones se
// leian pegados. Con 0,48 la fila respira sin costar una hoja.
const ALTO_FILA_DATOS = 0.48 * CM;
// Relleno interior del recuadro de datos. Sin esto el texto arranca en el mismo
// punto que el borde izquierdo y la altura de mayuscula de la primera fila toca
// la linea de arriba: el recuadro se lee como una linea de texto, no como un marco.
const RELLENO_DATOS = 5;
// Sangria de los parrafos que continuesan una condicion sin etiqueta nueva
// (los dos ultimos de Calidad). Van uno adentro para que se lean como incisos y
// no como condiciones nuevas.
const SANGRIA_CONTINUACION = 0.4 * CM;
// Holgura entre el valor de una columna y la etiqueta de la siguiente. Sin ella
// las columnas se tocan justo y un correo largo del proveedor se junta con
// "EMITIDO POR:" sin ningun espacio en blanco de por medio.
const HOLGURA = 0.35 * CM;

// Pie del documento: condiciones, hueco y firmas. Se miden contra los datos de
// esta orden (ver medirPie), no se hardcodean, porque cuantas lineas ocupa cada
// condicion depende de si el horario o el lugar de entrega envuelven.
const ALTO_TITULO_CONDICIONES = 10;
const ALTO_LINEA = 7.2; // una linea de Helvetica a 6 pt
const HUECO_CONDICIONES_FIRMAS = 0.8 * CM;
const ALTO_FIRMAS = 0.5 * CM + 9;
// Margen de seguridad de la reserva. heightOfString() mide cada trozo por
// separado y no sabe de negritas, asi que cuando una condicion parte en dos
// lineas puede quedarse corta. Este margen absorbe esa diferencia; la garantia
// de que nada se salga de la hoja no depende de aqui, sino de la comprobacion
// final que mueve el pie a otra pagina si aun asi no cabe.
const HOLGURA_RESERVA = 12;
// Y del pie de pagina, un poco dentro del margen inferior. Vive en el margen a
// proposito, pero no pegado al borde: una impresora de oficina no imprime a
// menos de 4 mm del canto y el pie se perderia al mandar a papel.
const Y_PIE_PAGINA = PAGINA.height - MARGEN + 3.5;
const BORDE_IMPRIMIBLE = 12; // 4.2 mm: lo que una impresora respeta de verdad

const AZUL_OSCURO = '#1A365D';
const AZUL = '#2B6CB0';
const GRIS_OSCURO = '#4A5568';
const GRIS = '#B0B0B0';
const ROJO = '#C53030';

// Razon social que sale impresa. Es una constante y no un dato de la base: si
// hay que cambiarla, se cambia aqui.
const RAZON_SOCIAL = 'CORPORACION DON LALO SAC';

/**
 * Reparte los anchos de una tabla para que llenen el ancho util exacto.
 *
 * Las medidas van en cm como proporciones, no como centimetros finales. Sumarlas
 * a mano contra el ancho de la hoja es como la tabla se desalinea: el dia que
 * la hoja cambia de tamano, la suma queda corta y la ultima columna se sale del
 * papel, o larga y pisa la tabla de al lado. Con esto la suma cuadra sola.
 *
 * @param {number[]} proporciones - Anchos relativos en cm.
 * @returns {number[]} Anchos en puntos, sumando ANCHO.
 */
function repartirAnchos(proporciones) {
  const total = proporciones.reduce((a, b) => a + b, 0);
  return proporciones.map(p => (p / total) * ANCHO);
}

// Tabla de productos. La descripcion se lleva la parte grande porque es lo que
// envuelve; las columnas de numeros se reparten lo justo para que los miles no
// se corten con puntos suspensivos.
const ANCHOS_PRODUCTOS = repartirAnchos([10.2, 1.9, 1.7, 2.9, 3.5, 3.1, 4.4]);
// Tabla de cuentas. El numero y el titular necesitan ancho para no partirse.
const ANCHOS_BANCOS = repartirAnchos([4.2, 4.8, 5.6, 2.4, 10.7]);

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

// Condiciones fijas del pie. Van como objetos y no como cadenas con <b> porque
// Calidad tiene dos parrafos mas que continuesan sin etiqueta nueva: con el
// formato de "<b>algo:</b> texto" no hay forma de decir "esta linea no abre
// condicion". Un parrafo sin `etiqueta` se dibuja solo, con sangria.
const CONDICIONES_FIJAS = [
  {
    etiqueta: 'Documentación',
    texto: 'Todo pedido debe llegar con su respectiva Orden de Compra, Guía de Remisión, Factura, Certificado de calidad y hojas de seguridad de ser el caso.'
  },
  {
    etiqueta: 'Calidad',
    texto: 'La mercadería enviada que se encuentre fuera de las especificaciones pactadas o no coincida con la Orden de Compra y sin previa coordinación no podrá ser recibida en nuestros almacenes y serán devueltos al vendedor por su cuenta y riesgo.'
  },
  {
    texto: 'La mercadería enviada de menos o más, que no coincida con la Orden de Compra y sin previa coordinación, no será recibida en nuestros almacenes.',
    sangria: true
  },
  {
    texto: 'La mercadería enviada que se encuentre en mal estado, ya sea envoltura rota, sucia y/o mal embalado, no será recibido en nuestros almacenes.',
    sangria: true
  },
  {
    etiqueta: 'Despacho',
    texto: 'El envío de los productos solicitados en esta orden debe efectuarse en la fecha y lugar indicado. Nos reservamos el derecho de rechazar los materiales que lleguen en lugar y fecha no establecidos.'
  },
  {
    etiqueta: 'Precio',
    texto: 'No estamos obligados a pagar un precio mayor a lo estipulado en esta orden.'
  }
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
  // Se pasa el tamano en puntos y no 'A4' con layout: 'landscape' para que las
  // medidas del codigo y las que ve pdfkit sean las mismas y no haya dos-truths.
  //
  // bufferPages guarda las hojas en memoria hasta el end(). Sin eso, pdfkit
  // escribe cada hoja apenas se llena y bufferedPageRange() no devuelve ninguna:
  // el pie con "pagina X de Y" necesita saber el total, y el total solo se
  // conoce cuando todas las hojas ya estan escritas. Son un par de paginas de
  // texto, la memoria no es un problema.
  const doc = new PDFDocument({
    size: [PAGINA.width, PAGINA.height],
    margin: MARGEN,
    bufferPages: true
  });
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

  // ---- Datos de la orden ----
  // Cuatro columnas y no dos. Es el cambio que hace que la orden quepa en una
  // hoja: los mismos datos, en vez de trece renglones en dos columnas, ocupan
  // cuatro. La hoja apaisada da el ancho justo para eso sin que el valor del
  // proveedor quede pisado por la etiqueta de al lado.
  const pares = [
    ['PROVEEDOR:', valorO(orden.proveedor_nombre_actual || orden.proveedor_nombre)],
    ['RUC:', valorO(orden.ruc)],
    ['ATENCIÓN:', valorO(orden.atencion || orden.contacto)],
    ['CEL:', valorO(orden.telefono)],
    ['E-MAIL:', valorO(orden.email)],
    ['FORMA DE PAGO:', valorO(orden.forma_pago)],
    ['MONEDA:', `${simbolo} ${valorO(orden.moneda)}`],
    ['EMITIDO POR:', valorO(emisor && emisor.nombre)],
    ['CARGO:', valorO(emisor && emisor.cargo)],
    ['CEL:', valorO(emisor && emisor.celular)],
    ['FECHA:', fmtFecha(orden.fecha_orden || orden.fecha_registro)],
    ['HORA:', valorO(fmtHora(orden.fecha_registro))],
    ['ÁREA SOLICITANTE:', valorO(orden.area_solicitante)],
    ['HORARIO RECEPCIÓN:', valorO(orden.horario_recepcion)]
  ];

  const yBloque = doc.y;
  const yFin = dibujarDatos(doc, pares, MARGEN + RELLENO_DATOS, yBloque, ANCHO - 2 * RELLENO_DATOS, 4);
  // El recuadro se dibuja al final para que el texto quede encima del borde.
  // El relleno va por dentro: el borde queda a RELLENO_DATOS del texto, no encima.
  doc.save().lineWidth(1).strokeColor(GRIS)
    .rect(MARGEN, yBloque - RELLENO_DATOS, ANCHO, yFin - yBloque + 2 * RELLENO_DATOS).stroke().restore();
  doc.y = yFin + RELLENO_DATOS + 0.5 * CM;

  // ---- Pie: medido antes, porque las tablas necesitan saber donde cortar ----
  const condiciones = paresCondiciones(orden);
  const limiteInferior = PAGINA.height - MARGEN - medirPie(doc, condiciones);

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
    encabezado: AZUL_OSCURO,
    limiteInferior
  });

  doc.font('Helvetica').fontSize(6)
    .text(`IGV aplicado: ${Number(orden.igv_pct) || 0}%`, MARGEN, doc.y + 0.12 * CM, { width: ANCHO, align: 'right' });
  doc.y += 0.5 * CM;

  // ---- Cuentas bancarias ----
  doc.font('Helvetica-Bold').fontSize(7.5).text('CUENTAS BANCARIAS AUTORIZADAS PARA PAGO:', MARGEN, doc.y, { width: ANCHO });
  doc.y += 0.25 * CM;
  if (bancos.length) {
    dibujarTabla(doc, {
      cabeceras: ['BANCO', 'TIPO DE CUENTA', 'NÚMERO DE CUENTA', 'MONEDA', 'TITULAR'],
      filas: bancos.map(c => ({
        celdas: [
          { texto: valorO(c.banco), al: 'left', envolver: true },
          { texto: valorO(c.tipo), al: 'left' },
          { texto: valorO(c.numero) },
          { texto: `${datosMoneda(c.moneda).simbolo} ${valorO(c.moneda)}` },
          { texto: valorO(c.titular), al: 'left' }
        ]
      })),
      anchos: ANCHOS_BANCOS,
      encabezado: GRIS_OSCURO,
      limiteInferior
    });
  } else {
    doc.font('Helvetica-Oblique').fontSize(7).fillColor('#555555')
      .text('El proveedor no tiene cuentas bancarias registradas.', MARGEN, doc.y, { width: ANCHO });
    doc.fillColor('#000000');
  }
  doc.y += 0.5 * CM;

  // ---- Condiciones generales y firmas ----
  // Si al terminar las condiciones ya se invadio el margen inferior, el pie
  // entero se dibuja en una hoja nueva. Es la unica garantia real de que las
  // firmas no salgan del papel: la reserva de arriba es una estimacion.
  const yPie = doc.y;
  dibujarCondiciones(doc, condiciones);
  if (doc.y > PAGINA.height - MARGEN - HUECO_CONDICIONES_FIRMAS - ALTO_FIRMAS) {
    doc.addPage({ size: [PAGINA.width, PAGINA.height], margin: MARGEN });
  }
  const yFirmas = Math.max(doc.y, yPie) + HUECO_CONDICIONES_FIRMAS;

  // La linea base se calcula una sola vez. text() mueve doc.y aunque se le
  // pase una Y explicita, asi que leer doc.y dentro del bucle apilaba las tres
  // firmas en cascada en vez de alinearlas.
  const anchoTercio = ANCHO / FIRMAS.length;
  FIRMAS.forEach((firma, i) => {
    const x = MARGEN + i * anchoTercio;
    // El ancho lleva 4 puntos de resto para que el texto de una firma no
    // invada el hueco de la siguiente.
    const ancho = anchoTercio - 4;
    doc.font('Helvetica').fontSize(7).text('_'.repeat(20), x, yFirmas, { width: ancho, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(7).text(firma, x, yFirmas + 0.5 * CM, { width: ancho, align: 'center' });
  });

  // Pie de pagina con la numeracion. Se dibuja al final porque el total de
  // paginas solo se conoce cuando todo el contenido ya esta colocado: se
  // recorre el rango guardado y se estampa hoja por hoja.
  const rango = doc.bufferedPageRange();
  if (rango.count > 1) {
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      doc.switchToPage(i);
      // El pie va dentro del margen inferior, que es justo donde pdfkit decide
      // que un texto no cabe y parte la hoja. Sin bajar el margen a cero, cada
      // pie abria una hoja en blanco: el PDF de dos paginas salia de cuatro.
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(6.5).fillColor(GRIS_OSCURO)
        .text(`Orden de compra N° ${String(orden.numero || '')}   |   Página ${i - rango.start + 1} de ${rango.count}`,
          MARGEN, Y_PIE_PAGINA, { width: ANCHO, align: 'center', lineBreak: false });
      doc.fillColor('#000000');
    }
  }

  doc.end();
  return terminado;
}

/** Escribe el bloque de condiciones al pie del documento. */
function dibujarCondiciones(doc, pares) {
  doc.font('Helvetica-Bold').fontSize(6).text('CONDICIONES:', MARGEN, doc.y, { width: ANCHO });
  doc.font('Helvetica').fontSize(6);
  for (const [negrita, normal, sangria = 0] of pares) {
    const x = MARGEN + sangria;
    const ancho = ANCHO - sangria;
    if (negrita) {
      doc.font('Helvetica-Bold').text(negrita, x, doc.y, { width: ancho, continued: true });
      doc.font('Helvetica').text(normal, { width: ancho });
    } else {
      // Sin etiqueta, el texto va con x y y propias. Pasando solo el ancho
      // seguiria donde quedara el cursor, y como no hay negrita que lo mueva de
      // la linea anterior, la continuacion sale pegada al margen y no a la
      // sangria que se le pidio.
      doc.font('Helvetica').text(normal, x, doc.y, { width: ancho });
    }
  }
}

/**
 * Escribe el bloque de datos del encabezado en varias columnas alineadas.
 *
 * Se mide antes de dibujar, en dos pasadas, y eso no es opcional:
 *
 *  - El ancho de la etiqueta sale de la etiqueta mas larga. Con una caja fija,
 *    "HORARIO RECEPCIÓN:" no entra y se parte en dos lineas, dejando la
 *    etiqueta y su valor desalineados.
 *  - El alto de cada renglon es el maximo entre columnas. Si cada columna
 *    avanzara su Y por su cuenta, en cuanto un valor envuelve (un correo o un
 *    nombre de proveedor largo) esa columna se correria hacia abajo y sus
 *    etiquetas dejarian de caer en linea con las de al lado. En un documento que
 *    van a firmar tres personas, esas filas torcidas se notan.
 *
 * @param {object} doc
 * @param {Array<[string,string]>} pares - Etiqueta y valor.
 * @param {number} x - Donde arranca el texto. Ya viene corrido por el relleno del
 *   recuadro, para que la primera letra no caiga encima del borde.
 * @param {number} ancho - Ancho disponible para las columnas, ya sin el relleno
 *   de los dos lados. Va aparte del ancho porque si no, cuatro columnas repartidas
 *   sobre el ancho completo se salen del recuadro por la derecha.
 * @param {number} columnas - Cuantas columnas.
 * @returns {number} La Y de debajo del bloque.
 */
function dibujarDatos(doc, pares, x, y, ancho, columnas) {
  const anchoColumna = ancho / columnas;
  const filasPorColumna = Math.ceil(pares.length / columnas);
  const bloques = [];
  for (let c = 0; c < columnas; c++) {
    bloques.push(pares.slice(c * filasPorColumna, (c + 1) * filasPorColumna));
  }

  doc.font('Helvetica-Bold').fontSize(TAMANO_DATOS);
  const anchoEtiqueta = Math.max(
    ANCHO_ETIQUETA,
    ...pares.map(([etiqueta]) => doc.widthOfString(etiqueta) + 3)
  );
  const anchoValor = anchoColumna - anchoEtiqueta - HOLGURA;

  // Pasada de medicion: alto del texto de cada celda con los anchos definitivos.
  // Se guarda el alto del texto y no el de la fila, porque el desvío vertical sale
  // de la diferencia entre las dos cosas.
  doc.font('Helvetica').fontSize(TAMANO_DATOS);
  const altoTexto = bloques.map(bloque => bloque.map(([etiqueta, valor]) =>
    Math.max(
      doc.heightOfString(etiqueta, { width: anchoEtiqueta }),
      doc.heightOfString(valor, { width: anchoValor })
    )));

  // Un alto por renglon, compartido por las cuatro columnas, y un solo desvío para
  // bajar el texto dentro de ese renglon. El desvío es uno por renglon y no por
  // celda a proposito: centrando cada celda por separado, en cuanto un valor
  // envuelve su etiqueta queda flotando en la mitad de la fila y deja de
  // alinearse con la primera linea del valor de al lado.
  const altoFila = [];
  const desvio = [];
  for (let f = 0; f < filasPorColumna; f++) {
    const alto = Math.max(...altoTexto.map(a => a[f] || 0));
    altoFila[f] = Math.max(ALTO_FILA_DATOS, alto);
    desvio[f] = (altoFila[f] - alto) / 2;
  }

  let yFin = y;
  bloques.forEach((bloque, c) => {
    const xc = x + c * anchoColumna;
    let yc = y;
    bloque.forEach(([etiqueta, valor], f) => {
      const yTexto = yc + desvio[f];
      doc.font('Helvetica-Bold').fontSize(TAMANO_DATOS)
        .text(etiqueta, xc, yTexto, { width: anchoEtiqueta, align: 'left', lineBreak: false });
      doc.font('Helvetica').text(valor, xc + anchoEtiqueta, yTexto, { width: anchoValor, align: 'left' });
      yc += altoFila[f];
    });
    yFin = Math.max(yFin, yc);
  });
  return yFin;
}

/**
 * Las condiciones del pie, como triplets [negrita, normal, sangria].
 *
 * Se separa del dibujado para poder medirlas antes de dibujar la tabla: la
 * tabla de productos necesita saber cuanto pie le queda libre para decidir por
 * donde cortar las filas.
 *
 * El tercer dato es la sangria en puntos, y la llevan los dos lados a proposito:
 * si medirPie midiera el parrafo de Calidad al ancho completo y se dibujara
 * angosto, la reserva seria mas alta que lo que ocupa de verdad y el pie terminaria
 * invadiendo el margen inferior. Medir y dibujar tienen que usar el mismo ancho.
 *
 * @param {object} orden
 * @returns {Array<[string,string,number]>}
 */
function paresCondiciones(orden) {
  const pares = [];
  for (const cond of CONDICIONES) {
    const crudo = String(orden[cond.campo] || '').trim();
    if (!crudo) continue;
    pares.push([`${cond.etiqueta}: `, `${cond.fecha ? fmtFecha(crudo) : crudo}\n`, 0]);
  }
  for (const fija of CONDICIONES_FIJAS) {
    pares.push([
      fija.etiqueta ? `${fija.etiqueta}: ` : '',
      `${fija.texto}\n`,
      fija.sangria ? SANGRIA_CONTINUACION : 0
    ]);
  }
  return pares;
}

/**
 * Alto que necesita el pie de esta orden: condiciones, hueco y firmas.
 *
 * Es una reserva, no una garantia. heightOfString() mide cada fragmento por
 * separado y no tiene en cuenta el texto encadenado en negrita y normal, asi
 * que si una condicion envuelve en dos lineas esta cuenta puede quedarse corta;
 * por eso HOLGURA_RESERVA. Lo que si garantiza que nada salga de la hoja es el
 * salto de pagina final, que corre el pie a otra hoja si no cabe.
 */
function medirPie(doc, pares) {
  doc.font('Helvetica').fontSize(6);
  let alto = ALTO_TITULO_CONDICIONES;
  for (const [negrita, normal, sangria = 0] of pares) {
    const ancho = ANCHO - sangria;
    const a = doc.heightOfString(negrita, { width: ancho });
    const b = doc.heightOfString(normal, { width: ancho });
    alto += Math.max(a, b, ALTO_LINEA);
  }
  return alto + HUECO_CONDICIONES_FIRMAS + ALTO_FIRMAS + HOLGURA_RESERVA;
}

/**
 * Dibuja una tabla con celdas de alto variable (por texto que envuelve) y deja
 * doc.y en la fila siguiente.
 *
 * Parte de pagina: antes de dibujar una fila se comprueba si cabe entera por
 * encima de limiteInferior y, si no, salta a una hoja nueva y vuelve a pintar
 * la cabecera. Sin esto una orden con veinte lineas no se parte: se dibuja de
 * mas alla del borde inferior y las ultimas filas se pierden, y el proveedor
 * recibe una compra con menos productos de los que dice tener.
 *
 * @param {object} doc
 * @param {{cabeceras:string[], filas:Array, anchos:number[], encabezado:string, pieDeTabla?:number}} opciones
 */
function dibujarTabla(doc, { cabeceras, filas, anchos, encabezado, limiteInferior }) {
  const x = MARGEN;
  const anchoTotal = anchos.reduce((a, b) => a + b, 0);
  const altoCabecera = 0.6 * CM;
  let y = doc.y;
  let continua = false;

  // La cabecera se vuelve a pintar en cada salto de pagina: sin ella, la segunda
  // hoja es una lista de numeros sin saber que columna es cual.
  const pintarCabecera = () => {
    doc.save().rect(x, y, anchoTotal, altoCabecera).fillColor(encabezado).fill().restore();
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#FFFFFF');
    let cx = x;
    cabeceras.forEach((h, i) => {
      doc.text(h, cx, y + 0.16 * CM, { width: anchos[i], align: 'center', lineBreak: false, ellipsis: true });
      cx += anchos[i];
    });
    doc.fillColor('#000000');
    y += altoCabecera;
  };
  pintarCabecera();

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

    if (y + alto > limiteInferior) {
      doc.addPage({ size: [PAGINA.width, PAGINA.height], margin: MARGEN });
      y = MARGEN;
      pintarCabecera();
      continua = true;
    }

    if (esTotal) {
      doc.save().rect(x, y, anchoTotal, alto).fillColor(AZUL).fill().restore();
      doc.fillColor('#FFFFFF');
    }
    doc.font(esTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5);
    let cx = x;
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
  return { fin: y, continua };
}

module.exports = {
  generarPDFOrdenCompra, fmtMoneda, fmtFecha, fmtHora, fmtCantidad,
  nombreArchivoSeguro, RAZON_SOCIAL,
  // Geometria de la hoja, expuesta para que las pruebas puedan comprobar que
  // nada se sale del papel sin tener que reimprimir las medidas aqui.
  PAGINA, MARGEN, ANCHO, Y_PIE_PAGINA, BORDE_IMPRIMIBLE, repartirAnchos
};