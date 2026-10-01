/**
 * Precios por proveedor e IGV, y facturas relacionadas a las OC/OS.
 *
 * Antes el unico precio persistido era ordenes_items.precio, que se congela
 * dentro de la orden. Sirve para saber cuanto costo cada linea historica, pero
 * no como precio de referencia: para saber que cobra hoy un proveedor habia que
 * buscarlo a mano en ordenes viejas. precios_proveedor es esa lista de
 * referencia, y precios_proveedor_historial conserva cada cambio para poder
 * ver cuanto subio un insumo en el tiempo.
 *
 * Las facturas no existian. Ahora una factura apunta a una orden (FK con ON
 * DELETE RESTRICT) y una orden puede tener varias: es el caso real de un
 * proveedor que factura un envio y despues otro a la misma orden.
 *
 * Sobre el IGV: el calculo vive entero en el servidor y el cliente nunca envia
 * ni el subtotal ni el IGV. Ordenes_compras_servicios.total NO cambia de
 * significado, sigue siendo la base imponible (suma de subtotales); el IGV va
 * en columnas nuevas (igv, total_igv) para no romper los totales de stock ni las
 * metricas que ya leen esa columna. Las ordenes que ya existian se completan
 * aqui con el 18% para que orden y factura queden sobre la misma base y sus
 * totales sean comparables.
 *
 * La semilla toma los precios reales que ya estan en ordenes_items, no valores
 * inventados, y usa ON CONFLICT DO NOTHING para poder re-ejecutar sin duplicar.
 */

export const up = (pgm) => {
  // ---- IGV en ordenes ----
  // total sigue siendo la base imponible; igv y total_igv son lo nuevo.
  pgm.addColumns('ordenes_compras_servicios', {
    moneda: { type: 'varchar(3)', notNull: true, default: 'PEN' },
    igv_pct: { type: 'numeric(5,2)', notNull: true, default: 18 },
    igv: { type: 'numeric(12,2)', notNull: true, default: 0 },
    total_igv: { type: 'numeric(12,2)', notNull: true, default: 0 }
  });

  // Completa las ordenes existentes con el 18%. ROUND evita arrastrar decimales
  // de numeric en las sumas posteriores.
  pgm.sql(`
    UPDATE ordenes_compras_servicios
    SET igv = ROUND(total * igv_pct / 100, 2),
        total_igv = ROUND(total + total * igv_pct / 100, 2)
    WHERE COALESCE(total, 0) > 0 AND COALESCE(igv, 0) = 0
  `);

  // ---- Lista de precios ----
  pgm.createTable('precios_proveedor', {
    id: { type: 'serial', primaryKey: true },
    proveedor_id: { type: 'int', notNull: true, references: 'proveedores(id)', onDelete: 'CASCADE' },
    producto: { type: 'varchar(200)', notNull: true },
    unidad: { type: 'varchar(20)', notNull: true, default: 'UNIDADES' },
    precio: { type: 'numeric(12,4)', notNull: true, default: 0 },
    moneda: { type: 'varchar(3)', notNull: true, default: 'PEN' },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  // El mismo insumo en distintos proveedores queda como filas distintas, que es
  // justo lo que permite comparar precios entre proveedores. El mismo insumo
  // repetido en un proveedor no: una sola fila con el precio vigente.
  pgm.addConstraint('precios_proveedor', 'uq_precios_proveedor',
    'UNIQUE(proveedor_id, producto, unidad)');
  pgm.createIndex('precios_proveedor', ['proveedor_id']);
  pgm.createIndex('precios_proveedor', ['producto']);

  // Un registro por cada cambio de precio. Se escribe en la misma transaccion
  // que el update del precio, asi que no puede quedar un precio viejo sin rastro.
  //
  // precio_id es nullable y ON DELETE SET NULL a proposito: el historial tiene
  // que sobrevivir a la baja del precio vigente. Por eso la fila guarda su propio
  // proveedor_nombre/producto/unidad: si el precio se elimina, el registro igual
  // dice que insumo era y en que proveedor, y no se pierde cuanto subio.
  pgm.createTable('precios_proveedor_historial', {
    id: { type: 'serial', primaryKey: true },
    precio_id: { type: 'int', references: 'precios_proveedor(id)', onDelete: 'SET NULL' },
    proveedor_id: { type: 'int', references: 'proveedores(id)', onDelete: 'SET NULL' },
    proveedor_nombre: { type: 'varchar(150)' },
    producto: { type: 'varchar(200)' },
    unidad: { type: 'varchar(20)' },
    moneda: { type: 'varchar(3)', notNull: true, default: 'PEN' },
    precio_anterior: { type: 'numeric(12,4)', notNull: true, default: 0 },
    precio_nuevo: { type: 'numeric(12,4)', notNull: true, default: 0 },
    usuario_cambio: { type: 'varchar(50)' },
    fecha_cambio: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('precios_proveedor_historial', ['precio_id']);
  pgm.createIndex('precios_proveedor_historial', ['proveedor_id']);
  pgm.createIndex('precios_proveedor_historial', ['fecha_cambio'], { descending: true });

  // ---- Facturas ----
  pgm.createTable('facturas', {
    id: { type: 'serial', primaryKey: true },
    tipo_comprobante: { type: 'varchar(20)', notNull: true, default: 'FACTURA' },
    serie: { type: 'varchar(20)', notNull: true, default: 'F001' },
    numero: { type: 'varchar(30)', notNull: true },
    fecha_factura: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    // RESTRICT a proposito: borrar una orden facturada dejaria la factura sin
    // orden a la que referirse, que es peor que impedir el borrado.
    orden_id: { type: 'int', notNull: true, references: 'ordenes_compras_servicios(id)', onDelete: 'RESTRICT' },
    proveedor_id: { type: 'int', references: 'proveedores(id)', onDelete: 'SET NULL' },
    proveedor_nombre: { type: 'varchar(150)' },
    moneda: { type: 'varchar(3)', notNull: true, default: 'PEN' },
    igv_pct: { type: 'numeric(5,2)', notNull: true, default: 18 },
    subtotal: { type: 'numeric(12,2)', notNull: true, default: 0 },
    igv: { type: 'numeric(12,2)', notNull: true, default: 0 },
    total: { type: 'numeric(12,2)', notNull: true, default: 0 },
    estado: { type: 'varchar(20)', notNull: true, default: 'PENDIENTE' },
    fecha_pago: { type: 'date' },
    observaciones: { type: 'text' },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  // Una factura real no se registra dos veces. Una orden si puede tener varias:
  // por eso el unico no lleva orden_id.
  pgm.addConstraint('facturas', 'uq_facturas_comprobante', 'UNIQUE(tipo_comprobante, serie, numero)');
  pgm.createIndex('facturas', ['orden_id']);
  pgm.createIndex('facturas', ['estado']);

  // ---- Semilla: precios reales ya registrados en ordenes_items ----
  // Toma el ultimo precio pagado de cada par (proveedor, producto) para que la
  // lista empiece con datos ciertos y no con supuestos.
  pgm.sql(`
    INSERT INTO precios_proveedor (proveedor_id, producto, unidad, precio, moneda, usuario_registro)
    SELECT DISTINCT ON (o.proveedor_id, LOWER(BTRIM(i.descripcion)))
      o.proveedor_id,
      i.descripcion,
      i.unidad,
      i.precio,
      'PEN',
      'migracion'
    FROM ordenes_items i
    JOIN ordenes_compras_servicios o ON o.id = i.orden_id
    WHERE o.proveedor_id IS NOT NULL
      AND LOWER(BTRIM(i.descripcion)) <> ''
      AND i.precio IS NOT NULL AND i.precio > 0
    ORDER BY o.proveedor_id, LOWER(BTRIM(i.descripcion)), o.id DESC
    ON CONFLICT (proveedor_id, producto, unidad) DO NOTHING
  `);

  // Deja constancia del alta inicial, igual que un alta hecha desde la pantalla.
  pgm.sql(`
    INSERT INTO precios_proveedor_historial
      (precio_id, proveedor_id, proveedor_nombre, producto, unidad, moneda, precio_anterior, precio_nuevo, usuario_cambio)
    SELECT p.id, p.proveedor_id, pr.nombre, p.producto, p.unidad, p.moneda, 0, p.precio, 'migracion'
    FROM precios_proveedor p
    JOIN proveedores pr ON pr.id = p.proveedor_id
    WHERE NOT EXISTS (
      SELECT 1 FROM precios_proveedor_historial h WHERE h.precio_id = p.id
    )
  `);
};

export const down = (pgm) => {
  pgm.dropTable('facturas');
  pgm.dropTable('precios_proveedor_historial');
  pgm.dropTable('precios_proveedor');

  pgm.dropColumns('ordenes_compras_servicios', ['total_igv', 'igv', 'igv_pct', 'moneda']);
};
