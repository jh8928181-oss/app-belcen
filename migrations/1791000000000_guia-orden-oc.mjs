// La guia queda pegada a la orden de compra contra la que se aplico.
//
// Antes la conformidad de una guia restaba el stock de proveedores emparejando
// por nombre de producto, sin orden de por medio: dos OC del mismo proveedor
// por el mismo insumo eran indistinguibles, el historial se anotaba con
// orden_ref = null y la orden no avanzaba nunca hacia COMPLETADA. Ahora la
// cabecera guarda contra que orden se aplico (ingresos_vigilancia.orden_id) y
// cada producto de esa guia contra que item de esa orden
// (registro_ingresos_almacen.orden_id + orden_item_id).
//
// asociacion recorre el ciclo de vida de cada fila de producto:
//   SIN_OC    entro por almacen o vigilancia sin orden y espera en el boton de
//             Notificaciones; mientras tanto no se descuenta nada.
//   ASOCIADA  ya abono su cantidad contra la orden y su stock de proveedor.
//   REVISADA  salida manual, para lo que no tiene orden que vincular.
//
// stock_proveedores.categoria trae la categoria del proveedor a la propia fila.
// La categoria se resolvia con un join contra proveedores cada vez que se
// listaba: si el proveedor se borraba, su inventario perdia la categoria y
// dejaba de agruparse por la lista de categorias ya establecida.

export const up = (pgm) => {
  pgm.addColumns('ingresos_vigilancia', {
    orden_id: { type: 'int' },
    orden_numero: { type: 'varchar(50)' }
  });

  pgm.addColumns('registro_ingresos_almacen', {
    orden_id: { type: 'int' },
    orden_item_id: { type: 'int' },
    asociacion: { type: 'varchar(20)', notNull: true, default: 'SIN_OC' }
  });

  pgm.addColumns('stock_proveedores', {
    categoria: { type: 'varchar(100)', notNull: true, default: 'General' }
  });

  pgm.addConstraint('ingresos_vigilancia', 'ingresos_vigilancia_orden_fk', {
    foreignKeys: {
      columns: 'orden_id',
      references: 'ordenes_compras_servicios(id)',
      onDelete: 'SET NULL'
    }
  });

  pgm.addConstraint('registro_ingresos_almacen', 'registro_ingresos_orden_fk', {
    foreignKeys: {
      columns: 'orden_id',
      references: 'ordenes_compras_servicios(id)',
      onDelete: 'SET NULL'
    }
  });

  pgm.addConstraint('registro_ingresos_almacen', 'registro_ingresos_orden_item_fk', {
    foreignKeys: {
      columns: 'orden_item_id',
      references: 'ordenes_items(id)',
      onDelete: 'SET NULL'
    }
  });

  pgm.addConstraint('registro_ingresos_almacen', 'registro_ingresos_asociacion_chk', {
    check: "asociacion IN ('SIN_OC', 'ASOCIADA', 'REVISADA')"
  });

  // La columna llega con 'General' para todas las filas existentes; este UPDATE
  // es el que le pone la categoria que ya tenia el proveedor. Prefiere la del
  // proveedor porque el inventario es por proveedor; la del insumo es solo el
  // ultimo recurso para lo que no tiene proveedor de alta.
  pgm.sql(`
    UPDATE stock_proveedores s
    SET categoria = COALESCE(
      (SELECT NULLIF(BTRIM(p.categoria), '')
         FROM proveedores p
        WHERE LOWER(BTRIM(p.nombre)) = LOWER(BTRIM(s.proveedor_nombre))),
      (SELECT NULLIF(BTRIM(i.categoria), '')
         FROM inventario i
        WHERE LOWER(BTRIM(i.nombre)) = LOWER(BTRIM(s.producto))
        LIMIT 1),
      'General');
  `);
};

export const down = (pgm) => {
  pgm.dropColumns('registro_ingresos_almacen', ['orden_id', 'orden_item_id', 'asociacion']);
  pgm.dropColumns('ingresos_vigilancia', ['orden_id', 'orden_numero']);
  pgm.dropColumns('stock_proveedores', ['categoria']);
};
