/**
 * Estados de pago reales de la factura: credito, cancelada y su vencimiento.
 *
 * Con PENDIENTE/PAGADA/ANULADA no habia forma de expresar las dos situaciones
 * que mas importan al pagarle a un proveedor: que te dieron plazo (credito, y
 * desde cuando se vence) y que la factura esta real pero no se va a cobrar
 * (cancelada: rechazada, en disputa, el proveedor la retiro). La segunda es
 * justamente lo que ANULADA no podia decir, porque anular significa que el
 * documento no existio.
 *
 * Por eso los dos estados se demarcan en la aritmetica de la orden y por eso
 * queda escrito aqui, no solo en el codigo:
 *
 *   estado      suma a facturado   suma a pagado
 *   PENDIENTE        si                  no
 *   CREDITO          si                  no
 *   PAGADA           si                  si
 *   CANCELADA        si                  no     <- deuda que no se cobra
 *   ANULADA          no                  no     <- el documento no existio
 *
 * CANCELADA cuenta como facturada porque la orden si se cubrio a ese precio, y
 * no cuenta como pagada porque nadie la pago, asi que queda siempre abierta en
 * el por cobrar: es justamente el monto que la empresa perdio y hay que ver.
 * ANULADA, en cambio, devuelve el importe al por facturar, como si nunca se
 * hubiera emitido.
 *
 * fecha_vencimiento es una sola columna y no un numero de dias: el cliente
 * resuelve los dias contra fecha_factura y lo que se guarda es la fecha ya
 * sumada, que es la unica que hace falta para saber si vencio y no obliga a
 * recalcular en cada consulta. Solo aplica a CREDITO.
 *
 * El CHECK es la red de seguridad de esa tabla de arriba: sin el, un estado mal
 * escrito no romperia un error visible, se colaria en los SUM y las ordenes
 * mostrarian saldos que nadie sabe explicar.
 */

export const up = (pgm) => {
  pgm.addColumns('facturas', {
    fecha_vencimiento: { type: 'date' }
  });

  pgm.addConstraint('facturas', 'ck_facturas_estado',
    "CHECK (estado IN ('PENDIENTE', 'CREDITO', 'PAGADA', 'CANCELADA', 'ANULADA'))");

  // Solo las de credito tienen vencimiento, y de las que lo tienen solo nos
  // interesa el indice sobre la fecha. Indice parcial: no paga por el resto.
  pgm.createIndex('facturas', ['fecha_vencimiento'], {
    name: 'idx_facturas_vencidas',
    where: "estado = 'CREDITO' AND fecha_vencimiento IS NOT NULL"
  });
};

export const down = (pgm) => {
  pgm.dropIndex('facturas', { name: 'idx_facturas_vencidas' });
  pgm.dropConstraint('facturas', 'ck_facturas_estado');
  pgm.dropColumns('facturas', ['fecha_vencimiento']);
};
