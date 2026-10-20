/**
 * Ingresos SIN GUIA: se registran productos que entran al inventario de una
 * vez y el documento se vincula despues.
 *
 * registro_ingresos_almacen guarda ingreso_id para poder encontrar todas las
 * filas de un mismo ingreso (una por producto) cuando llegue la guia: sin eso
 * no hay como saber que filas actualizar, porque numero_guia esta vacio.
 * ON DELETE SET NULL: si alguna vez se borra la cabecera, el detalle del
 * registro se conserva (es la historia de lo que llego).
 */

export const up = (pgm) => {
  pgm.addColumns('registro_ingresos_almacen', {
    ingreso_id: { type: 'int' }
  });
  pgm.addConstraint('registro_ingresos_almacen', 'registro_ingresos_ingreso_fk', {
    foreignKeys: {
      columns: 'ingreso_id',
      references: 'ingresos_vigilancia(id)',
      onDelete: 'SET NULL'
    }
  });
  pgm.createIndex('registro_ingresos_almacen', 'ingreso_id', {
    name: 'idx_registro_ingresos_ingreso_id'
  });
};

export const down = (pgm) => {
  pgm.dropIndex('registro_ingresos_almacen', 'ingreso_id', {
    ifExists: true,
    name: 'idx_registro_ingresos_ingreso_id'
  });
  pgm.dropConstraint('registro_ingresos_almacen', 'registro_ingresos_ingreso_fk', { ifExists: true });
  pgm.dropColumns('registro_ingresos_almacen', ['ingreso_id']);
};
