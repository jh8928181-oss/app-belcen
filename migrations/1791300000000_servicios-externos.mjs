// Maquila externa (SAUÑE y B&M DYLPLAST): se les envian etiquetas y
// preformas (en millares) y devuelven botellas por guia de remision o por
// control interno. Cada guia descuenta 1 a 1 (una botella = una preforma +
// una etiqueta, pasando unidades a millares) y suma las botellas al stock.
//
// El control interno no mueve stock: es un anuncio pendiente. Cuando el
// servicio emite la guia, el operario la vincula a sus controles a mano.
// La guia queda PENDIENTE hasta que se le vincula su factura.

export const up = (pgm) => {
  pgm.createTable('servicios_envios', {
    id: { type: 'serial', primaryKey: true },
    fecha: { type: 'date', default: pgm.func('CURRENT_DATE') },
    servicio: { type: 'varchar(50)', notNull: true },
    articulo_id: { type: 'int', references: 'inventario(id)' },
    articulo_nombre: { type: 'varchar(150)', notNull: true },
    tipo_item: { type: 'varchar(20)' },
    cantidad: { type: 'numeric(14,6)', notNull: true },
    usuario: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });
  pgm.addConstraint('servicios_envios', 'servicios_envios_servicio_chk', {
    check: "servicio IN ('SAUÑE', 'B&M DYLPLAST')"
  });
  pgm.addConstraint('servicios_envios', 'servicios_envios_cantidad_chk', {
    check: 'cantidad > 0'
  });

  pgm.createTable('servicios_guias', {
    id: { type: 'serial', primaryKey: true },
    servicio: { type: 'varchar(50)', notNull: true },
    tipo_doc: { type: 'varchar(20)', notNull: true },
    numero: { type: 'varchar(50)', notNull: true },
    fecha: { type: 'date' },
    producto: { type: 'varchar(150)', notNull: true },
    producto_key: { type: 'varchar(100)' },
    cantidad: { type: 'numeric(14,6)', notNull: true },
    etiqueta_id: { type: 'int', references: 'inventario(id)' },
    etiqueta_nombre: { type: 'varchar(150)' },
    cant_etiquetas: { type: 'numeric(14,6)' },
    preforma_id: { type: 'int', references: 'inventario(id)' },
    preforma_nombre: { type: 'varchar(150)' },
    cant_preformas: { type: 'numeric(14,6)' },
    botella_id: { type: 'int', references: 'inventario(id)' },
    factura_numero: { type: 'varchar(50)' },
    factura_estado: { type: 'varchar(20)', notNull: true, default: 'PENDIENTE' },
    controles_ids: { type: 'int[]', notNull: true, default: '{}' },
    estado: { type: 'varchar(20)', notNull: true, default: 'PENDIENTE' },
    usuario: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });
  pgm.addConstraint('servicios_guias', 'servicios_guias_servicio_chk', {
    check: "servicio IN ('SAUÑE', 'B&M DYLPLAST')"
  });
  pgm.addConstraint('servicios_guias', 'servicios_guias_tipo_chk', {
    check: "tipo_doc IN ('GUIA', 'CONTROL')"
  });
  pgm.addConstraint('servicios_guias', 'servicios_guias_cantidad_chk', {
    check: 'cantidad > 0'
  });
  pgm.addConstraint('servicios_guias', 'servicios_guias_factura_chk', {
    check: "factura_estado IN ('PENDIENTE', 'VINCULADA')"
  });
  pgm.addConstraint('servicios_guias', 'servicios_guias_estado_chk', {
    check: "estado IN ('PENDIENTE', 'VINCULADA')"
  });
  pgm.createIndex('servicios_guias', ['servicio', 'tipo_doc', 'numero'], {
    name: 'idx_servicios_guias_numero',
    unique: true
  });
};

export const down = (pgm) => {
  pgm.dropTable('servicios_guias');
  pgm.dropTable('servicios_envios');
};
