/**
 * PDF de la orden de pedido de venta.
 *
 * Carta vertical: encabezado con el N° de pedido, datos de logística, tabla de
 * ítems (solicitado / despacho directo / a producir) y el cuadro de estado de
 * insumos cuando el pedido queda con faltantes. No recalcula nada: todo sale
 * del pedido ya evaluado que guarda la base.
 */

const PDFDocument = require('pdfkit');

const CM = 28.3465;
const MARGEN = 1.4 * CM;
const ANCHO = 595.28 - 2 * MARGEN;

const AZUL = '#155e75';
const GRIS = '#4A5568';
const GRIS_CLARO = '#E2E8F0';
const ROJO = '#C53030';
const VERDE = '#2F855A';

function repartirAnchos(proporciones) {
  const total = proporciones.reduce((a, b) => a + b, 0);
  return proporciones.map(p => (p / total) * ANCHO);
}

const ANCHOS_ITEMS = repartirAnchos([7.2, 2.2, 2.2, 2.4]);
const ANCHOS_INSUMOS = repartirAnchos([7.0, 2.4, 2.4, 2.2]);

function filaTabla(doc, celdas, anchos, opciones = {}) {
  const { y, alto = 16, fondo = null, colorTexto = '#1A202C', bold = false, alineados = [] } = opciones;
  const x0 = MARGEN;
  if (fondo) {
    doc.rect(x0, y, ANCHO, alto).fill(fondo);
  }
  let x = x0;
  celdas.forEach((celda, i) => {
    const ancho = anchos[i];
    doc.fillColor(colorTexto).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    doc.text(String(celda == null ? '' : celda), x + 4, y + 4, {
      width: ancho - 8,
      align: alineados[i] || 'left',
      lineBreak: false,
      ellipsis: true
    });
    x += ancho;
  });
  doc.moveTo(x0, y + alto).lineTo(x0 + ANCHO, y + alto).strokeColor(GRIS_CLARO).lineWidth(0.5).stroke();
  return y + alto;
}

function etiquetaValor(doc, y, etiqueta, valor, anchoEtiqueta = 3.4 * CM) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRIS).text(etiqueta, MARGEN, y, { continued: false });
  doc.font('Helvetica').fillColor('#1A202C').text(String(valor == null || valor === '' ? '—' : valor), MARGEN + anchoEtiqueta, y, {
    width: ANCHO - anchoEtiqueta
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
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGEN, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // Encabezado
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(14)
        .text('CORPORACIÓN BELCÉN S.A.C.', MARGEN, MARGEN);
      doc.font('Helvetica').fontSize(8).fillColor(GRIS)
        .text('R.U.C. 20601832616 — Lurigancho, Lima', MARGEN, doc.y + 1);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#1A202C')
        .text('ORDEN DE PEDIDO', MARGEN, MARGEN + 2, { align: 'right', width: ANCHO });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(AZUL)
        .text(String(datos.numero_pedido || '—'), MARGEN, doc.y + 2, { align: 'right', width: ANCHO });
      let y = doc.y + 12;
      doc.moveTo(MARGEN, y).lineTo(MARGEN + ANCHO, y).strokeColor(AZUL).lineWidth(1.2).stroke();
      y += 10;

      // Estado del pedido
      const estado = ETIQUETAS_ESTADO[datos.estado] || { texto: datos.estado, color: GRIS };
      doc.rect(MARGEN, y, ANCHO, 18).fill(GRIS_CLARO);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(estado.color)
        .text(`ESTADO: ${estado.texto}`, MARGEN + 6, y + 5, { width: ANCHO - 12 });
      y += 28;

      // Datos de logística
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1A202C').text('DATOS DEL PEDIDO', MARGEN, y);
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(8.5);
      y = etiquetaValor(doc, y, 'FECHA DE REGISTRO:', datos.fecha_registro_larga || datos.fecha_registro);
      y = etiquetaValor(doc, y, 'FECHA SOLICITADA DE DESPACHO:', datos.fecha_despacho || 'Sin fecha');
      y = etiquetaValor(doc, y, 'SOLICITANTE:', datos.solicitante);
      y = etiquetaValor(doc, y, 'VEHÍCULO (PLACA):', datos.vehiculo);
      y = etiquetaValor(doc, y, 'CHOFER:', datos.chofer);
      y = etiquetaValor(doc, y, 'DESTINO:', datos.tipo_destino);
      y = etiquetaValor(doc, y, 'DIRECCIÓN DE ENTREGA:', datos.direccion);
      y = etiquetaValor(doc, y, 'OBSERVACIONES:', datos.observaciones);
      y += 8;

      // Tabla de ítems
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1A202C').text('DETALLE DE PRODUCTOS', MARGEN, y);
      y = doc.y + 4;
      y = filaTabla(doc, ['PRODUCTO', 'SOLICITADO', 'DESPACHO', 'A PRODUCIR'], ANCHOS_ITEMS, {
        y, fondo: AZUL, colorTexto: '#FFFFFF', bold: true,
        alineados: ['left', 'center', 'center', 'center']
      });
      (datos.items || []).forEach((item, i) => {
        y = filaTabla(doc, [
          item.nombre_producto || item.producto_key,
          item.cantidad_solicitada,
          item.cantidad_despacho,
          item.cantidad_produccion
        ], ANCHOS_ITEMS, {
          y,
          fondo: i % 2 ? '#F7FAFC' : null,
          alineados: ['left', 'center', 'center', 'center']
        });
      });
      y = filaTabla(doc, [
        'TOTAL',
        datos.total_solicitado,
        datos.total_despacho,
        datos.total_produccion
      ], ANCHOS_ITEMS, {
        y, fondo: GRIS_CLARO, bold: true, alineados: ['left', 'center', 'center', 'center']
      });
      y += 12;

      // Cuadro de insumos
      const insumos = (datos.insumos || []).filter(i => i.estado !== 'OK');
      if (insumos.length) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(ROJO)
          .text('ESTADO DE INSUMOS — PRODUCCIÓN BLOQUEADA', MARGEN, y);
        y = doc.y + 4;
        y = filaTabla(doc, ['INSUMO', 'REQUERIDO', 'DISPONIBLE', 'FALTANTE'], ANCHOS_INSUMOS, {
          y, fondo: ROJO, colorTexto: '#FFFFFF', bold: true,
          alineados: ['left', 'center', 'center', 'center']
        });
        insumos.forEach((ins, i) => {
          y = filaTabla(doc, [
            ins.nombre_insumo,
            Number(ins.requerido).toLocaleString('es-PE', { maximumFractionDigits: 3 }),
            Number(ins.disponible).toLocaleString('es-PE', { maximumFractionDigits: 3 }),
            Number(ins.faltante).toLocaleString('es-PE', { maximumFractionDigits: 3 })
          ], ANCHOS_INSUMOS, {
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

      // Pie
      doc.font('Helvetica').fontSize(7.5).fillColor(GRIS)
        .text(
          'Documento generado por el ERP Belcén. La cantidad a despachar se descuenta del stock al registrar la salida; ' +
          'la cantidad a producir se atiende contra el consolidado de requerimientos de planta.',
          MARGEN, Math.max(y, doc.y) + 14, { width: ANCHO, align: 'justify' }
        );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { generarPDFPedidoVenta };
