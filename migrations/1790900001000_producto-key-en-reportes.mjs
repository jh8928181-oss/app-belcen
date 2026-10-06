// El reporte guarda la clave de producto con la que se produjo.
//
// Al borrar un reporte, las cajas se devuelven a producto_terminado. Esa clave
// se re-resolvía desde el nombre de la receta, así que si entre la producción
// y el borrado la receta se desactivó, se renombró o se borró, la clave salía
// vacía: los insumos volvían (van por el snapshot de desglose_insumos) pero las
// cajas no, y el descuadre quedaba permanente y silencioso.
//
// Guardar la clave en el reporte elimina esa dependencia. Los reportes previos
// quedan con la columna en NULL y siguen usando el camino legacy, que es
// exactamente el comportamiento de siempre para ellos.
//
// No es una FK a producto_terminado a propósito: la fila de producto terminado
// puede no existir todavía (se crea con el primer reporte), y porque el borrado
// de producto terminado no está permitido mientras haya historial.

export const up = (pgm) => {
  pgm.addColumns('reportes_produccion', { producto_key: { type: 'varchar(150)' } });
  pgm.createIndex('reportes_produccion', 'producto_key', { name: 'idx_reportes_prod_key' });
};

export const down = (pgm) => {
  pgm.dropIndex('reportes_produccion', 'idx_reportes_prod_key');
  pgm.dropColumns('reportes_produccion', ['producto_key']);
};