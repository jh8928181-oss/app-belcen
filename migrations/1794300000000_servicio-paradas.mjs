// PARADO DE SERVICIO en servicios externos de soplado: cierra el saldo de un
// servicio (contador a 0) sin borrar nada de lo ya enviado/recibido.
//
// Cada parada guarda sus lineas: por insumo queda el saldo liquidado y la
// decision elegida por el usuario (MERMA = se descarta, no vuelve al stock;
// ALMACEN = se suma de vuelta al mismo articulo de inventario, con su
// historial). Las etiquetas con saldo menor a 1 millar se muestran premarcadas
// a MERMA.
//
// No se agrega CHECK al servicio: la lista vive en SERVICIOS_SOPLADO de
// index.js y ya tuvo que corregirse en dos migraciones al agregar un
// proveedor. La ruta valida el servicio contra esa misma lista.

export const up = (pgm) => {
  pgm.createTable('servicios_paradas', {
    id: { type: 'serial', primaryKey: true },
    fecha: { type: 'date', default: pgm.func('CURRENT_DATE') },
    servicio: { type: 'varchar(50)', notNull: true },
    observacion: { type: 'varchar(300)' },
    usuario: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createTable('servicios_paradas_items', {
    id: { type: 'serial', primaryKey: true },
    parada_id: { type: 'int', notNull: true, references: 'servicios_paradas(id)', onDelete: 'CASCADE' },
    articulo_id: { type: 'int', references: 'inventario(id)' },
    articulo_nombre: { type: 'varchar(150)', notNull: true },
    tipo_item: { type: 'varchar(20)' },
    saldo: { type: 'numeric(14,6)', notNull: true },
    decision: { type: 'varchar(20)', notNull: true }
  });
  pgm.addConstraint('servicios_paradas_items', 'servicios_paradas_items_decision_chk', {
    check: "decision IN ('MERMA', 'ALMACEN')"
  });
  pgm.addIndex('servicios_paradas_items', 'parada_id', {
    name: 'idx_servicios_paradas_items'
  });
};

export const down = (pgm) => {
  pgm.dropTable('servicios_paradas_items');
  pgm.dropTable('servicios_paradas');
};
