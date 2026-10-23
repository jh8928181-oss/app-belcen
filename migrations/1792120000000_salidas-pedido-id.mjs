/**
 * Vincula las salidas de almacén con el pedido de venta que las originó.
 *
 * Protocolo de despacho de pedidos: al despachar un pedido, además de
 * descontar producto terminado, se registra una fila en salidas_almacen
 * (una por producto) para que el despacho aparezca en el historial de la
 * pestaña Salidas como cualquier otra salida. pedido_id deja el rastro
 * para poder distinguirlas: no se borran ni se editan desde Salidas (el
 * pedido es el dueño del flujo), y para saber a qué pedido pertenecen.
 */

export const up = (pgm) => {
  pgm.sql('ALTER TABLE salidas_almacen ADD COLUMN pedido_id int REFERENCES pedidos_venta(id);');
  pgm.createIndex('salidas_almacen', ['pedido_id'], { name: 'idx_salidas_pedido' });
};

export const down = (pgm) => {
  pgm.dropIndex('salidas_almacen', 'idx_salidas_pedido');
  pgm.sql('ALTER TABLE salidas_almacen DROP COLUMN pedido_id;');
};
