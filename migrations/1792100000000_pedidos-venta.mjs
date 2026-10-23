/**
 * Pedidos de venta: cabecera + items + insumos faltantes.
 *
 * El pedido no mueve stock al crearse: reparte cada línea entre lo que ya está
 * en almacén (despacho directo) y lo que falta producir, y deja anotados los
 * insumos que impiden producir. El descuento real ocurre al despachar (salida
 * de producto terminado) y la producción se atiende contra el consolidado.
 */
export const up = (pgm) => {
  pgm.createTable('pedidos_venta', {
    id: { type: 'serial', primaryKey: true },
    numero_pedido: { type: 'varchar(30)', notNull: true, unique: true },
    fecha_registro: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    fecha_despacho: { type: 'date' },
    solicitante: { type: 'varchar(100)' },
    vehiculo: { type: 'varchar(60)' },
    chofer: { type: 'varchar(100)' },
    tipo_destino: {
      type: 'varchar(20)',
      notNull: true,
      check: "tipo_destino IN ('TIENDA','REPARTO','PROVINCIA')"
    },
    direccion: { type: 'text' },
    estado: { type: 'varchar(30)', notNull: true, default: 'PARA_DESPACHO' },
    total_solicitado: { type: 'integer', notNull: true, default: 0 },
    total_despacho: { type: 'integer', notNull: true, default: 0 },
    total_produccion: { type: 'integer', notNull: true, default: 0 },
    observaciones: { type: 'text' },
    usuario_registro: { type: 'varchar(50)' }
  });
  pgm.createIndex('pedidos_venta', 'estado', { name: 'idx_pedidos_venta_estado' });

  pgm.createTable('pedidos_venta_items', {
    id: { type: 'serial', primaryKey: true },
    pedido_id: { type: 'integer', notNull: true, references: 'pedidos_venta(id)', onDelete: 'CASCADE' },
    producto_key: { type: 'varchar(100)', notNull: true },
    nombre_producto: { type: 'varchar(150)' },
    cantidad_solicitada: { type: 'integer', notNull: true },
    cantidad_despacho: { type: 'integer', notNull: true, default: 0 },
    cantidad_produccion: { type: 'integer', notNull: true, default: 0 },
    cantidad_despachada: { type: 'integer', notNull: true, default: 0 },
    cantidad_producida: { type: 'integer', notNull: true, default: 0 }
  });
  pgm.createIndex('pedidos_venta_items', 'pedido_id', { name: 'idx_pedidos_items_pedido' });
  pgm.createIndex('pedidos_venta_items', 'producto_key', { name: 'idx_pedidos_items_producto' });

  pgm.createTable('pedidos_venta_insumos', {
    id: { type: 'serial', primaryKey: true },
    pedido_id: { type: 'integer', notNull: true, references: 'pedidos_venta(id)', onDelete: 'CASCADE' },
    producto_key: { type: 'varchar(100)' },
    insumo_id: { type: 'integer', references: 'inventario(id)', onDelete: 'SET NULL' },
    nombre_insumo: { type: 'varchar(150)', notNull: true },
    requerido: { type: 'numeric(14,3)', notNull: true, default: 0 },
    disponible: { type: 'numeric(14,3)', notNull: true, default: 0 },
    faltante: { type: 'numeric(14,3)', notNull: true, default: 0 },
    estado: { type: 'varchar(15)', notNull: true, default: 'FALTANTE' }
  });
  pgm.createIndex('pedidos_venta_insumos', 'pedido_id', { name: 'idx_pedidos_insumos_pedido' });
};

export const down = (pgm) => {
  pgm.dropTable('pedidos_venta_insumos');
  pgm.dropTable('pedidos_venta_items');
  pgm.dropTable('pedidos_venta');
};
