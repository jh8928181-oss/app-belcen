/**
 * PDF de la ORDEN DE PEDIDO de venta.
 *
 * Es un documento hacia afuera (cliente / planta), no un reporte interno: la
 * tabla de productos trae solo producto y cantidad pedida — el reparto entre
 * despacho y producción vive en el ERP, no en el papel. Sin fecha solicitada
 * (no aporta al documento y su fecha cruda ensuciaba el layout).
 *
 * Carta horizontal por defecto. Un pedido "demasiado grande" (muchos ítems o
 * muchos insumos faltantes) pasa a vertical: la hoja vertical da más altura,
 * y es lo que necesita una lista larga. No recalcula nada: todo sale del
 * pedido ya evaluado que guarda la base.
 */

const PDFDocument = require('pdfkit');

const CM = 28.3465;
const MARGEN = 1.4 * CM;
const ANCHO_CARTA_VERTICAL = 595.28;
const ANCHO_CARTA_HORIZONTAL = 792;

const AZUL = '#155e75';
const GRIS = '#4A5568';
const GRIS_CLARO = '#E2E8F0';
const ROJO = '#C53030';
const VERDE = '#2F855A';

// Un pedido con más de 7 ítems, o ítems + faltantes sumando más de 14 filas,
// ya no cabe cómodo en horizontal: se imprime vertical.
const TOPE_ITEMS_HORIZONTAL = 7;
const TOPE_FILAS_HORIZONTAL = 14;

function repartirAnchos(anchoTotal, proporciones) {
  const total = proporciones.reduce((a, b) => a + b, 0);
  return proporciones.map(p => (p / total) * anchoTotal);
}

function filaTabla(doc, celdas, anchos, ancho, opciones = {}) {
  const { y, alto = 16, fondo = null, colorTexto = '#1A202C', bold = false, alineados = [] } = opciones;
  const x0 = MARGEN;
  if (fondo) {
    doc.rect(x0, y, ancho, alto).fill(fondo);
  }
  let x = x0;
  celdas.forEach((celda, i) => {
    const anchoCol = anchos[i];
    doc.fillColor(colorTexto).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    doc.text(String(celda == null ? '' : celda), x + 4, y + 4, {
      width: anchoCol - 8,
      align: alineados[i] || 'left',
      lineBreak: false,
      ellipsis: true
    });
    x += anchoCol;
  });
  doc.moveTo(x0, y + alto).lineTo(x0 + ancho, y + alto).strokeColor(GRIS_CLARO).lineWidth(0.5).stroke();
  return y + alto;
}

function etiquetaValor(doc, y, etiqueta, valor, ancho, anchoEtiqueta = 3.4 * CM) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRIS).text(etiqueta, MARGEN, y, { continued: false });
  doc.font('Helvetica').fillColor('#1A202C').text(String(valor == null || valor === '' ? '—' : valor), MARGEN + anchoEtiqueta, y, {
    width: ancho - anchoEtiqueta
  });
  return doc.y + 2;
}

const ETIQUETAS_ESTADO = {
  PARA_DESPACHO: { texto: 'PARA DESPACHO (stock completo)', color: VERDE },
  EN_PRODUCCION: { texto: 'EN PRODUCCIÓN (falta elaborar)', color: AZUL },
  INSUMOS_FALTANTES: { texto: 'INSUMOS FALTANTES (bloqueado para producción)', color: ROJO },
  DESPACHADO: { texto: 'DESPACHADO', color: VERDE },
  CANCELADO: { texto: 'CANCELADO', color: GRIS }
};

/**
 * @param {object} datos - Pedido armado por /api/pedidos/:id (cabecera + items + insumos).
 * @returns {Promise<Buffer>}
 */
function generarPDFPedidoVenta(datos) {
  return new Promise((resolve, reject) => {
    const items = datos.items || [];
    const faltantes = (datos.insumos || []).filter(i => i.estado !== 'OK');
    const demasiadoGrande = items.length > TOPE_ITEMS_HORIZONTAL ||
      (items.length + faltantes.length) > TOPE_FILAS_HORIZONTAL;
    const vertical = demasiadoGrande;
    const anchoPagina = vertical ? ANCHO_CARTA_VERTICAL : ANCHO_CARTA_HORIZONTAL;
    const ancho = anchoPagina - 2 * MARGEN;
    const anchosItems = repartirAnchos(ancho, [9.2, 2]);
    const anchosInsumos = repartirAnchos(ancho, [7.0, 2.4, 2.4, 2.2]);

    const doc = new PDFDocument({
      size: 'LETTER',
      layout: vertical ? 'portrait' : 'landscape',
      margin: MARGEN,
      bufferPages: true
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // Encabezado
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(14)
        .text('CORPORACIÓN DON LALO S.A.C.', MARGEN, MARGEN);
      doc.font('Helvetica').fontSize(8).fillColor(GRIS)
        .text('R.U.C. 20601832616 — Lurigancho, Lima', MARGEN, doc.y + 1);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#1A202C')
        .text('ORDEN DE PEDIDO', MARGEN, MARGEN + 2, { align: 'right', width: ancho });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(AZUL)
        .text(String(datos.numero_pedido || '—'), MARGEN, doc.y + 2, { align: 'right', width: ancho });
      let y = doc.y + 12;
      doc.moveTo(MARGEN, y).lineTo(MARGEN + ancho, y).strokeColor(AZUL).lineWidth(1.2).stroke();
      y += 10;

      // Estado del pedido
      const estado = ETIQUETAS_ESTADO[datos.estado] || { texto: datos.estado, color: GRIS };
      doc.rect(MARGEN, y, ancho, 18).fill(GRIS_CLARO);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(estado.color)
        .text(`ESTADO: ${estado.texto}`, MARGEN + 6, y + 5, { width: ancho - 12 });
      y += 28;

      // Datos de logística
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1A202C').text('DATOS DEL PEDIDO', MARGEN, y);
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(8.5);
      y = etiquetaValor(doc, y, 'FECHA DE REGISTRO:', datos.fecha_registro_larga || datos.fecha_registro, ancho);
      y = etiquetaValor(doc, y, 'SOLICITANTE:', datos.solicitante, ancho);
      y = etiquetaValor(doc, y, 'VEHÍCULO (PLACA):', datos.vehiculo, ancho);
      y = etiquetaValor(doc, y, 'CHOFER:', datos.chofer, ancho);
      y = etiquetaValor(doc, y, 'DESTINO:', datos.tipo_destino, ancho);
      y = etiquetaValor(doc, y, 'DIRECCIÓN DE ENTREGA:', datos.direccion, ancho);
      y = etiquetaValor(doc, y, 'OBSERVACIONES:', datos.observaciones, ancho);
      y += 8;

      // Tabla de ítems: solo lo pedido. El reparto despacho/producción es
      // interno del ERP y no va en el documento.
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1A202C').text('DETALLE DE PRODUCTOS', MARGEN, y);
      y = doc.y + 4;
      y = filaTabla(doc, ['PRODUCTO', 'CANTIDAD'], anchosItems, ancho, {
        y, fondo: AZUL, colorTexto: '#FFFFFF', bold: true,
        alineados: ['left', 'center']
      });
      items.forEach((item, i) => {
        y = filaTabla(doc, [
          item.nombre_producto || item.producto_key,
          item.cantidad_solicitada
        ], anchosItems, ancho, {
          y,
          fondo: i % 2 ? '#F7FAFC' : null,
          alineados: ['left', 'center']
        });
      });
      y = filaTabla(doc, ['TOTAL', datos.total_solicitado], anchosItems, ancho, {
        y, fondo: GRIS_CLARO, bold: true, alineados: ['left', 'center']
      });
      y += 12;

      // Cuadro de insumos (solo si hay faltantes: es lo que bloquea producción)
      if (faltantes.length) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(ROJO)
          .text('ESTADO DE INSUMOS — PRODUCCIÓN BLOQUEADA', MARGEN, y);
        y = doc.y + 4;
        y = filaTabla(doc, ['INSUMO', 'REQUERIDO', 'DISPONIBLE', 'FALTANTE'], anchosInsumos, ancho, {
          y, fondo: ROJO, colorTexto: '#FFFFFF', bold: true,
          alineados: ['left', 'center', 'center', 'center']
        });
        faltantes.forEach((ins, i) => {
          y = filaTabla(doc, [
            ins.nombre_insumo,
            Number(ins.requerido).toLocaleString('es-PE', { maximumFractionDigits: 3 }),
            Number(ins.disponible).toLocaleString('es-PE', { maximumFractionDigits: 3 }),
            Number(ins.faltante).toLocaleString('es-PE', { maximumFractionDigits: 3 })
          ], anchosInsumos, ancho, {
            y, fondo: i % 2 ? '#FFF5F5' : null, colorTexto: ROJO,
            alineados: ['left', 'center', 'center', 'center']
          });
        });
        y += 10;
      } else if (Number(datos.total_produccion) > 0) {
        doc.font('Helvetica').fontSize(8.5).fillColor(VERDE)
          .text('Insumos verificados: la producción puede avanzar con los insumos en stock.', MARGEN, y);
        y = doc.y + 10;
      }

      // Pie pegado al contenido: sin el bloque fijo al fondo que dejaba la
      // mitad de la hoja vacía.
      doc.font('Helvetica').fontSize(7.5).fillColor(GRIS)
        .text(
          'Documento generado por el ERP Belcén. La cantidad a despachar se descuenta del stock al registrar la salida; ' +
          'la cantidad a producir se atiende contra el consolidado de requerimientos de planta.',
          MARGEN, Math.max(y, doc.y) + 14, { width: ancho, align: 'justify' }
        );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { generarPDFPedidoVenta };
