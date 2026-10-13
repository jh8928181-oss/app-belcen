// Si envasado produce sin stock suficiente, el producto terminado igual se
// registra y lo que falto de cada insumo queda PENDIENTE: almacén lo ve,
// lo ajusta para seguir trabajando y el pendiente se salda después
// vinculándolo a un reporte (soplado) o una guía que traiga ese insumo.
export const up = (pgm) => {
  pgm.createTable('ajustes_pendientes', {
    id: { type: 'serial', primaryKey: true },
    fecha: { type: 'date', default: pgm.func('CURRENT_DATE') },
    origen: { type: 'varchar(50)', notNull: true, default: 'ENVASADO' },
    reporte_id: { type: 'int', references: 'reportes_produccion(id)' },
    articulo_id: { type: 'int', references: 'inventario(id)' },
    articulo_nombre: { type: 'varchar(150)', notNull: true },
    cantidad_pendiente: { type: 'numeric(14,6)', notNull: true },
    cantidad_aplicada: { type: 'numeric(14,6)', notNull: true, default: 0 },
    estado: { type: 'varchar(20)', notNull: true, default: 'PENDIENTE' },
    vinculo_tipo: { type: 'varchar(20)' },
    vinculo_ref: { type: 'varchar(100)' },
    usuario: { type: 'varchar(50)' },
    aplicado_por: { type: 'varchar(50)' },
    fecha_aplicacion: { type: 'timestamp' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });
  pgm.addConstraint('ajustes_pendientes', 'ajustes_pendientes_cantidad_chk', {
    check: 'cantidad_pendiente > 0'
  });
  pgm.addConstraint('ajustes_pendientes', 'ajustes_pendientes_estado_chk', {
    check: "estado IN ('PENDIENTE', 'APLICADA')"
  });
  pgm.createIndex('ajustes_pendientes', 'estado', { name: 'idx_ajustes_pendientes_estado' });
};

export const down = (pgm) => {
  pgm.dropTable('ajustes_pendientes');
};
