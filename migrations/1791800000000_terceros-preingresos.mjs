// Pre-ingreso de botellas sopladas por terceros (Opción 1: stock en tránsito).
// El tercero avisa que hay lotes listos y se jalan a la línea ANTES de que
// emita su guía oficial. El pre-ingreso NO mueve stock: es el anuncio que
// habilita el consumo (producción descuenta y lo que falte cae a ajustes
// pendientes, como siempre). Cuando llega la guía oficial se vincula: las
// botellas ingresan al inventario, se saldan los pendientes de ese artículo
// y queda la conciliación (guía vs estimado).
export const up = (pgm) => {
  pgm.createTable('terceros_preingresos', {
    id: { type: 'serial', primaryKey: true },
    codigo: { type: 'varchar(20)', unique: true },
    fecha: { type: 'date', default: pgm.func('CURRENT_DATE') },
    tercero: { type: 'varchar(100)', notNull: true },
    articulo_id: { type: 'int', references: 'inventario(id)' },
    articulo_nombre: { type: 'varchar(150)', notNull: true },
    cantidad_estimada: { type: 'numeric(14,6)', notNull: true },
    cantidad_guia: { type: 'numeric(14,6)' },
    numero_guia: { type: 'varchar(50)' },
    estado: { type: 'varchar(20)', notNull: true, default: 'PREINGRESO' },
    observaciones: { type: 'varchar(250)' },
    usuario_registro: { type: 'varchar(50)' },
    usuario_vincula: { type: 'varchar(50)' },
    fecha_vinculacion: { type: 'timestamp' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });
  pgm.addConstraint('terceros_preingresos', 'terceros_preingresos_cantidad_chk', {
    check: 'cantidad_estimada > 0'
  });
  pgm.addConstraint('terceros_preingresos', 'terceros_preingresos_estado_chk', {
    check: "estado IN ('PREINGRESO', 'VINCULADO')"
  });
  // Una guía oficial se vincula una sola vez por tercero (los NULL de los
  // pre-ingresos aún sin guía no chocan entre sí).
  pgm.createIndex('terceros_preingresos', ['tercero', 'numero_guia'], {
    name: 'idx_terceros_preingresos_guia',
    unique: true
  });
  pgm.createIndex('terceros_preingresos', 'estado', { name: 'idx_terceros_preingresos_estado' });
};

export const down = (pgm) => {
  pgm.dropTable('terceros_preingresos');
};
