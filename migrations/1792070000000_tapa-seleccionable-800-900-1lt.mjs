/**
 * Tapa de uso vuelta a elegir por el operario en TODOS los productos de las
 * denominaciones 800 ml, 900 ml y 1 Lt (Don Lalo, B1, Belini, Timonel, Vega).
 *
 * El selector del Envasado dejó de depender del nombre del producto y ahora
 * sale de la receta vigente: linea seleccionable + receta_insumo_opciones
 * (igual que Faisan 900 ml). Aqui se marca como seleccionable la linea de
 * tapa de esas recetas y se le ofrecen las cuatro tapas dosificadoras N° 26
 * de inventario (Dorado, Celeste, Rojo, Verde). La tapa que cada receta ya
 * usaba sigue siendo el valor por defecto; el operario solo cambia CUAL.
 */

const OPCIONES_TAPA_26 = [
  { id: 35, orden: 0 }, // Tapa dosif. N° 26 blanco / Dorado
  { id: 36, orden: 1 }, // Tapa Dosif. N° 26 blanco / Celeste
  { id: 68, orden: 2 }, // Tapa Dosif. N° 26 blanco / ROJO
  { id: 69, orden: 3 }  // Tapa Dosif. N° 26 blanco / VERDE
];

const PRODUCTOS = [
  'donlalo_800ml',
  'b1_900ml',
  'belini_900ml',
  'timonel_900ml',
  'vega_900ml',
  'b1_1lt',
  'belini_1lt'
];

export const up = (pgm) => {
  const lista = PRODUCTOS.map(k => `'${k}'`).join(', ');
  const opciones = OPCIONES_TAPA_26
    .map(o => `(${o.id}, ${o.orden})`)
    .join(', ');
  pgm.sql(`
    DO $$
    DECLARE
      rec RECORD;
      op INTEGER;
      orden INTEGER;
    BEGIN
      FOR rec IN
        SELECT ri.id AS linea_id
          FROM recetas r
          JOIN receta_insumos ri ON ri.receta_id = r.id
          JOIN inventario inv ON inv.id = ri.insumo_id
         WHERE r.activa = true
           AND r.producto_key IN (${lista})
           -- Solo la linea de tapa/tapon por NOMBRE: la categoria TAPAS Y
           -- ACCESORIOS tambien incluye asas, que no son elegibles.
           AND (UPPER(inv.nombre) LIKE '%TAPA%'
                OR UPPER(inv.nombre) LIKE '%TAPON%')
      LOOP
        UPDATE receta_insumos SET seleccionable = true WHERE id = rec.linea_id;
        FOR op, orden IN SELECT t.id, t.orden FROM (VALUES ${opciones}) AS t(id, orden) LOOP
          INSERT INTO receta_insumo_opciones (receta_insumo_id, insumo_id, orden)
          VALUES (rec.linea_id, op, orden)
          ON CONFLICT (receta_insumo_id, insumo_id) DO NOTHING;
        END LOOP;
      END LOOP;
    END $$;
  `);
};

export const down = (pgm) => {
  const lista = PRODUCTOS.map(k => `'${k}'`).join(', ');
  const ids = OPCIONES_TAPA_26.map(o => o.id).join(', ');
  pgm.sql(`
    DELETE FROM receta_insumo_opciones op
     USING receta_insumos ri, recetas r
     WHERE op.receta_insumo_id = ri.id
       AND ri.receta_id = r.id
       AND r.producto_key IN (${lista})
       AND op.insumo_id IN (${ids});
    UPDATE receta_insumos ri
       SET seleccionable = false
      FROM recetas r
     WHERE ri.receta_id = r.id
       AND r.producto_key IN (${lista})
       AND ri.seleccionable = true;
  `);
};
