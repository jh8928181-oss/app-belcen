// Soplado trabaja con dos líneas: la automática y la manual. Cada línea
// lleva su molde puesto (ej. automática con molde de 1 Lt etiquetando
// Belini 1 Lt, manual con molde de 800 ml etiquetando Don Lalo 800 ml) y el
// molde se puede cambiar: cada reporte guarda línea + molde, y la línea
// conserva el último molde con el que produjo.
export const up = (pgm) => {
  pgm.createTable('soplado_lineas', {
    linea: { type: 'varchar(20)', primaryKey: true },
    nombre: { type: 'varchar(100)', notNull: true },
    molde_actual: { type: 'varchar(100)' },
    fecha_actualizacion: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });
  pgm.sql(`INSERT INTO soplado_lineas (linea, nombre, molde_actual) VALUES
    ('AUTOMATICA', 'Línea automática', NULL),
    ('MANUAL', 'Línea manual', NULL)`);

  pgm.addColumns('reportes_soplado', {
    linea: { type: 'varchar(20)', default: 'AUTOMATICA' },
    molde: { type: 'varchar(100)' }
  });
  pgm.addConstraint('reportes_soplado', 'reportes_soplado_linea_chk', {
    check: "linea IN ('AUTOMATICA', 'MANUAL')"
  });
  pgm.createIndex('reportes_soplado', 'linea', { name: 'idx_reportes_soplado_linea' });
};

export const down = (pgm) => {
  pgm.dropConstraint('reportes_soplado', 'reportes_soplado_linea_chk');
  pgm.dropColumns('reportes_soplado', ['linea', 'molde']);
  pgm.dropTable('soplado_lineas');
};
