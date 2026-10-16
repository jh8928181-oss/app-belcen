/**
 * Faisan entra a produccion con su receta propia y con la TAPA SELECCIONABLE
 * por el operario:
 *
 * - receta_insumos.seleccionable marca la linea que el operario puede cambiar
 *   (la tapa de Faisan: dorado, rojo o verde) y receta_insumo_opciones guarda
 *   que insumos de inventario son elegibles. La cantidad y la unidad las fija
 *   la receta; el operario solo elige CUAL.
 * - reportes_produccion.tapa_insumo_id guarda la tapa elegida al abrir la
 *   produccion: el cierre la usa para descontar la tapa correcta aunque el
 *   operario no este enfrente del formulario, y al borrar/ver informes el
 *   desglose se calcula igual que al producir.
 * - Receta faisan_900ml: botella y caja propias de Faisan (ya estan en
 *   inventario) y la linea de tapa seleccionable con sus tres opciones.
 */

const ID_BOTELLA_FAISAN_900 = 84;
const ID_CAJA_FAISAN_900 = 87;
const ID_TAPA_DEFECTO = 35; // Tapa dosif. N° 26 blanco / Dorado
const ID_TAPA_ROJA = 68;    // Tapa Dosif. N° 26 blanco / ROJO
const ID_TAPA_VERDE = 69;   // Tapa Dosif. N° 26 blanco / VERDE

export const up = (pgm) => {
  pgm.addColumns('receta_insumos', {
    seleccionable: { type: 'boolean', notNull: true, default: false }
  });

  pgm.createTable('receta_insumo_opciones', {
    id: { type: 'serial', primaryKey: true },
    receta_insumo_id: { type: 'int', notNull: true, references: 'receta_insumos(id)', onDelete: 'cascade' },
    insumo_id: { type: 'int', notNull: true, references: 'inventario(id)' },
    orden: { type: 'int', notNull: true, default: 0 }
  });
  pgm.createIndex('receta_insumo_opciones', ['receta_insumo_id'], { name: 'idx_opciones_linea' });
  pgm.addConstraint('receta_insumo_opciones', 'uq_opciones_linea_insumo', 'UNIQUE(receta_insumo_id, insumo_id)');

  pgm.addColumns('reportes_produccion', {
    tapa_insumo_id: { type: 'int', references: 'inventario(id)' }
  });

  // Receta de Faisan 900 ml: nace inactiva y se activa al final para no
  // pelear con el indice parcial de "una receta vigente por producto".
  pgm.sql(`
    DO $$
    DECLARE
      receta_id INTEGER;
      tapa_linea_id INTEGER;
    BEGIN
      INSERT INTO recetas (producto_key, nombre_producto, origen, version, vigente_desde, activa, created_by, observaciones)
      VALUES ('faisan_900ml', 'Aceite de Soya Faisan 900 ml', 'producto_terminado', 1, CURRENT_DATE, false, 'seed',
              'Receta inicial Faisan: la tapa la elige el operario al registrar la produccion')
      RETURNING id INTO receta_id;

      INSERT INTO receta_insumos (receta_id, insumo_nombre, insumo_id, cantidad_por_caja, unidad_medida, obligatorio, orden, notas)
      VALUES
        (receta_id, 'Botella Faisan x 900 ML', ${ID_BOTELLA_FAISAN_900}, 12, 'UNIDADES', true, 0, NULL),
        (receta_id, 'Caja Faisan 900 ml x 12 und', ${ID_CAJA_FAISAN_900}, 1, 'UNIDADES', true, 1, NULL);

      INSERT INTO receta_insumos (receta_id, insumo_nombre, insumo_id, cantidad_por_caja, unidad_medida, obligatorio, orden, notas, seleccionable)
      VALUES (receta_id, 'Tapa dosif. N° 26 blanco / Dorado', ${ID_TAPA_DEFECTO}, 0.012, 'MILL', true, 2,
              'Tapa que elige el operario al registrar la produccion', true)
      RETURNING id INTO tapa_linea_id;

      INSERT INTO receta_insumo_opciones (receta_insumo_id, insumo_id, orden)
      VALUES (tapa_linea_id, ${ID_TAPA_DEFECTO}, 0), (tapa_linea_id, ${ID_TAPA_ROJA}, 1), (tapa_linea_id, ${ID_TAPA_VERDE}, 2);

      UPDATE recetas SET activa = true WHERE id = receta_id;
    END $$;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DELETE FROM recetas WHERE producto_key = 'faisan_900ml' AND created_by = 'seed';`);
  pgm.dropColumns('reportes_produccion', ['tapa_insumo_id']);
  pgm.dropTable('receta_insumo_opciones');
  pgm.dropColumns('receta_insumos', ['seleccionable']);
};
