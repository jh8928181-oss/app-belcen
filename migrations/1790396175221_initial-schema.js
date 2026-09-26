/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  // ===== INVENTARIO =====
  pgm.createTable('inventario', {
    id: { type: 'serial', primaryKey: true },
    nombre: { type: 'varchar(150)', unique: true, notNull: true },
    categoria: { type: 'varchar(100)' },
    stock: { type: 'numeric(10,2)', default: 0 },
    unidad_medida: { type: 'varchar(50)', default: 'UNIDADES' },
    estado: { type: 'varchar(50)', default: 'STOCK SUFICIENTE' }
  });

  // ===== PRODUCTO TERMINADO =====
  pgm.createTable('producto_terminado', {
    id: { type: 'serial', primaryKey: true },
    producto_key: { type: 'varchar(100)', unique: true, notNull: true },
    nombre_producto: { type: 'varchar(150)', notNull: true },
    stock_cajas: { type: 'int', default: 0 },
    stock_minimo: { type: 'int', default: 0 }
  });

  // ===== INGRESOS VIGILANCIA =====
  pgm.createTable('ingresos_vigilancia', {
    id: { type: 'serial', primaryKey: true },
    tipo_documento: { type: 'varchar(50)' },
    numero_guia: { type: 'varchar(100)' },
    proveedor: { type: 'varchar(150)' },
    chofer: { type: 'varchar(150)' },
    dni_chofer: { type: 'varchar(50)' },
    placa: { type: 'varchar(50)' },
    lugar_partida: { type: 'varchar(150)' },
    punto_llegada: { type: 'varchar(150)' },
    observaciones: { type: 'text' },
    foto_url: { type: 'text' },
    usuario_vigilancia: { type: 'varchar(50)' },
    items_json: { type: 'text' },
    estado: { type: 'varchar(100)', default: 'PENDIENTE CONFORMIDAD' },
    fecha_ingreso: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
    fecha_anulacion: { type: 'timestamp' },
    anulado_por: { type: 'varchar(50)' },
    observacion_anulacion: { type: 'text' }
  });

  // ===== SALIDAS ALMACEN =====
  pgm.createTable('salidas_almacen', {
    id: { type: 'serial', primaryKey: true },
    fecha_salida: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
    tipo_registro: { type: 'varchar(30)' },
    numero_guia: { type: 'varchar(100)' },
    empresa: { type: 'varchar(150)' },
    ruc: { type: 'varchar(20)' },
    destino: { type: 'varchar(150)' },
    chofer_licencia: { type: 'varchar(150)' },
    placa: { type: 'varchar(50)' },
    punto_partida: { type: 'varchar(150)' },
    articulo_id: { type: 'int', references: 'inventario(id)' },
    producto_key: { type: 'varchar(100)' },
    cantidad_salida: { type: 'numeric(10,2)' },
    usuario_registro: { type: 'varchar(50)' },
    estado_guia: { type: 'varchar(50)', default: 'REGULARIZADO' },
    guia_url: { type: 'text' },
    despacho_id: { type: 'varchar(50)' }
  });

  // ===== REPORTES PRODUCCION =====
  pgm.createTable('reportes_produccion', {
    id: { type: 'serial', primaryKey: true },
    fecha_produccion: { type: 'date', default: pgm.func('CURRENT_DATE') },
    presentacion: { type: 'varchar(150)' },
    cantidad_cajas: { type: 'int' },
    unidad_medida: { type: 'varchar(20)', default: 'CAJAS' },
    toneladas: { type: 'numeric(10,2)' },
    observaciones: { type: 'text' },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
    desglose_insumos: { type: 'text' }
  });

  // ===== REGISTRO INGRESOS ALMACEN =====
  pgm.createTable('registro_ingresos_almacen', {
    id: { type: 'serial', primaryKey: true },
    fecha_registro: { type: 'date' },
    numero_guia: { type: 'varchar(100)' },
    proveedor: { type: 'varchar(150)' },
    producto_nombre: { type: 'varchar(150)' },
    cantidad: { type: 'numeric(10,2)' },
    estado: { type: 'varchar(50)' },
    articulo_id: { type: 'int', references: 'inventario(id)' },
    categoria: { type: 'varchar(100)' },
    unidad_medida: { type: 'varchar(20)' }
  });

  // ===== HISTORIAL CIERRES PRODUCCION =====
  pgm.createTable('historial_cierres_produccion', {
    id: { type: 'serial', primaryKey: true },
    fecha_cierre: { type: 'date', notNull: true },
    total_cajas: { type: 'numeric(10,2)', default: 0 },
    total_toneladas: { type: 'numeric(10,2)', default: 0 },
    usuario_cierre: { type: 'varchar(50)' },
    detalle_json: { type: 'text' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  // ===== USUARIOS SISTEMA =====
  pgm.createTable('usuarios_sistema', {
    id: { type: 'serial', primaryKey: true },
    usuario: { type: 'varchar(50)', unique: true, notNull: true },
    password: { type: 'varchar(300)', notNull: true },
    rol: { type: 'varchar(30)', notNull: true }
  });

  // ===== REPORTES REFINADO =====
  pgm.createTable('reportes_refinado', {
    id: { type: 'serial', primaryKey: true },
    fecha_reporte: { type: 'date', notNull: true },
    turno: { type: 'varchar(10)', notNull: true, default: 'DIA' },
    insumos_json: { type: 'text', notNull: true },
    aceite_json: { type: 'text', notNull: true },
    totales_json: { type: 'text' },
    observaciones: { type: 'text' },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  }, { constraints: { unique: ['fecha_reporte', 'turno'] } });

  // ===== STOCK INSUMOS REFINADO =====
  pgm.createTable('stock_insumos_refinado', {
    id: { type: 'serial', primaryKey: true },
    nombre: { type: 'varchar(150)', unique: true, notNull: true },
    um: { type: 'varchar(20)', notNull: true, default: 'KG' },
    stock: { type: 'numeric(12,2)', notNull: true, default: 0 },
    estado: { type: 'varchar(50)', notNull: true, default: 'STOCK SUFICIENTE' },
    usuario_ajuste: { type: 'varchar(50)' },
    fecha_ajuste: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  // ===== REPORTES SOPLADO =====
  pgm.createTable('reportes_soplado', {
    id: { type: 'serial', primaryKey: true },
    fecha_reporte: { type: 'date', default: pgm.func('CURRENT_DATE') },
    preforma_nombre: { type: 'varchar(150)' },
    botella_tipo: { type: 'varchar(100)' },
    botella_nombre: { type: 'varchar(150)' },
    cantidad_botellas: { type: 'int' },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  // ===== ESTADO LINEAS =====
  pgm.createTable('estado_lineas', {
    id: { type: 'serial', primaryKey: true },
    area: { type: 'varchar(50)', unique: true, notNull: true },
    estado: { type: 'varchar(20)', notNull: true, default: 'PARADO' },
    usuario_registro: { type: 'varchar(50)' },
    fecha_actualizacion: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
    proximo_producto: { type: 'varchar(150)' }
  });

  // ===== HISTORIAL INVENTARIO =====
  pgm.createTable('historial_inventario', {
    id: { type: 'serial', primaryKey: true },
    fecha: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
    tipo: { type: 'varchar(30)', notNull: true, default: 'MOVIMIENTO' },
    origen: { type: 'varchar(50)' },
    producto: { type: 'varchar(150)', notNull: true },
    producto_key: { type: 'varchar(100)' },
    articulo_id: { type: 'int' },
    cantidad: { type: 'numeric(12,3)', notNull: true, default: 0 },
    tipo_cambio: { type: 'varchar(10)', notNull: true, default: 'SUMA' },
    stock_anterior: { type: 'numeric(12,3)' },
    stock_nuevo: { type: 'numeric(12,3)' },
    usuario: { type: 'varchar(50)' },
    referencia: { type: 'text' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('historial_inventario', 'fecha', { descending: true, name: 'idx_historial_fecha' });
  pgm.createIndex('historial_inventario', 'tipo', { name: 'idx_historial_tipo' });

  // ===== PROVEEDORES =====
  pgm.createTable('proveedores', {
    id: { type: 'serial', primaryKey: true },
    nombre: { type: 'varchar(150)', unique: true, notNull: true },
    categoria: { type: 'varchar(50)' },
    ruc: { type: 'varchar(20)' },
    telefono: { type: 'varchar(50)' },
    direccion: { type: 'varchar(200)' },
    email: { type: 'varchar(100)' },
    contacto: { type: 'varchar(150)' },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  // ===== ORDENES COMPRAS SERVICIOS =====
  pgm.createTable('ordenes_compras_servicios', {
    id: { type: 'serial', primaryKey: true },
    tipo: { type: 'varchar(5)', notNull: true },
    numero: { type: 'varchar(50)', notNull: true },
    fecha_orden: { type: 'date' },
    proveedor_id: { type: 'int' },
    proveedor_nombre: { type: 'varchar(150)' },
    estado: { type: 'varchar(20)', notNull: true, default: 'PENDIENTE' },
    observaciones: { type: 'text' },
    total: { type: 'numeric(12,2)', default: 0 },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  }, { constraints: { unique: ['tipo', 'numero'] } });

  // ===== ORDENES ITEMS =====
  pgm.createTable('ordenes_items', {
    id: { type: 'serial', primaryKey: true },
    orden_id: { type: 'int', notNull: true, references: 'ordenes_compras_servicios(id)', onDelete: 'CASCADE' },
    descripcion: { type: 'varchar(200)', notNull: true },
    unidad: { type: 'varchar(20)', default: 'UNIDADES' },
    cantidad: { type: 'numeric(12,2)', notNull: true, default: 0 },
    precio: { type: 'numeric(12,2)', default: 0 },
    subtotal: { type: 'numeric(12,2)', default: 0 },
    recibido: { type: 'numeric(12,2)', default: 0 }
  });

  // ===== STOCK PROVEEDORES =====
  pgm.createTable('stock_proveedores', {
    id: { type: 'serial', primaryKey: true },
    proveedor_nombre: { type: 'varchar(150)', notNull: true },
    producto: { type: 'varchar(200)', notNull: true },
    unidad: { type: 'varchar(20)', default: 'UNIDADES' },
    stock: { type: 'numeric(12,2)', notNull: true, default: 0 },
    usuario_registro: { type: 'varchar(50)' },
    fecha_actualizacion: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('stock_proveedores', ['proveedor_nombre', 'producto'], { unique: true, name: 'uq_stock_proveedores' });

  // ===== STOCK PROVEEDORES HISTORIAL =====
  pgm.createTable('stock_proveedores_historial', {
    id: { type: 'serial', primaryKey: true },
    tipo: { type: 'varchar(20)', notNull: true },
    origen: { type: 'varchar(30)' },
    proveedor: { type: 'varchar(150)' },
    producto: { type: 'varchar(200)' },
    unidad: { type: 'varchar(20)' },
    cantidad: { type: 'numeric(12,2)', notNull: true, default: 0 },
    orden_ref: { type: 'varchar(50)' },
    guia_ref: { type: 'varchar(100)' },
    usuario: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('stock_proveedores_historial', 'fecha_registro', { descending: true, name: 'idx_stock_prov_hist_fecha' });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('stock_proveedores_historial');
  pgm.dropTable('stock_proveedores');
  pgm.dropTable('ordenes_items');
  pgm.dropTable('ordenes_compras_servicios');
  pgm.dropTable('proveedores');
  pgm.dropTable('historial_inventario');
  pgm.dropTable('estado_lineas');
  pgm.dropTable('reportes_soplado');
  pgm.dropTable('stock_insumos_refinado');
  pgm.dropTable('reportes_refinado');
  pgm.dropTable('usuarios_sistema');
  pgm.dropTable('historial_cierres_produccion');
  pgm.dropTable('registro_ingresos_almacen');
  pgm.dropTable('reportes_produccion');
  pgm.dropTable('salidas_almacen');
  pgm.dropTable('ingresos_vigilancia');
  pgm.dropTable('producto_terminado');
  pgm.dropTable('inventario');
};