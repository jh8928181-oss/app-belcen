/**
 * Restaura la tapa de uso elegible en las denominaciones que faltaban:
 * 500 ml (B1, Belini) y 3 Lt (Belini).
 *
 * Mismo mecanismo que 1792070000000: la linea de tapa de la receta vigente
 * pasa a seleccionable y receta_insumo_opciones guarda los insumos elegibles.
 * Los 500 ml usan la dosificadora N° 26 (mismas 4 opciones que 800/900/1Lt);
 * el 3 Lt usa su propia tapa "Tapa color Celeste 3lt", unica de esa
 * denominacion en inventario.
 */

const PRODUCTOS_26 = ['b1_500ml', 'belini_500ml'];
const PRODUCTOS_3LT = ['belini_3lt'];

const OPCIONES_TAPA_26 = [
  { id: 35, orden: 0 }, // Tapa dosif. N° 26 blanco / Dorado
  { id: 36, orden: 1 }, // Tapa Dosif. N° 26 blanco / Celeste
  { id: 68, orden: 2 }, // Tapa Dosif. N° 26 blanco / ROJO
  { id: 69, orden: 3 }  // Tapa Dosif. N° 26 blanco / VERDE
];

const OPCIONES_TAPA_3LT = [
  { id: 43, orden: 0 }  // Tapa color Celeste 3lt
];

function marcarSeleccionable(productos, opciones) {
  const lista = productos.map(k => `'${k}'`).join(', ');
  const vals = opciones.map(o => `(${o.id}, ${o.orden})`).join(', ');
  return `
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
        FOR op, orden IN SELECT t.id, t.orden FROM (VALUES ${vals}) AS t(id, orden) LOOP
          INSERT INTO receta_insumo_opciones (receta_insumo_id, insumo_id, orden)
          VALUES (rec.linea_id, op, orden)
          ON CONFLICT (receta_insumo_id, insumo_id) DO NOTHING;
        END LOOP;
      END LOOP;
    END $$;
  `;
}

function fijarFijo(productos, opciones) {
  const lista = productos.map(k => `'${k}'`).join(', ');
  const ids = opciones.map(o => o.id).join(', ');
  return `
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
  `;
}

export const up = (pgm) => {
  pgm.sql(marcarSeleccionable(PRODUCTOS_26, OPCIONES_TAPA_26));
  pgm.sql(marcarSeleccionable(PRODUCTOS_3LT, OPCIONES_TAPA_3LT));
};

export const down = (pgm) => {
  pgm.sql(fijarFijo(PRODUCTOS_26, OPCIONES_TAPA_26));
  pgm.sql(fijarFijo(PRODUCTOS_3LT, OPCIONES_TAPA_3LT));
};
