export const up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      r RECORD;
      ins RECORD;
      receta_id INTEGER;
      insumos_arr JSONB := '[
        {"kind": "b1_200ml", "ins": [["Botella de 200 ml - B-1", 24], ["Tapa Tapon 26mm (200ml)", 0.024], ["Caja B-1 x 200 ml", 1]]},
        {"kind": "b1_500ml", "ins": [["Botella de 500 ml - B-1", 12], ["Tapa dosif. N° 26 blanco / Dorado", 0.012], ["Caja B-1 x 500 ml", 1]]},
        {"kind": "b1_900ml", "ins": [["Botella de 900 ml - B-1", 12], ["Tapa dosif. N° 26 blanco / Dorado", 0.012], ["Caja B-1 x 900 ml", 1]]},
        {"kind": "b1_1lt", "ins": [["Botella de 1 Lt - B-1", 12], ["Tapa dosif. N° 26 blanco / Dorado", 0.012], ["Caja B-1 x 1 lt", 1]]},
        {"kind": "b1_2lt", "ins": [["Botella de 2 Lt - B-1", 6], ["Tapa color Rojo 2lt", 0.006], ["Caja B-1 x 2 lt", 1]]},
        {"kind": "b1_5lt", "ins": [["Galonera B-1 x 5 lt", 4], ["Tapa color rojo 5lt", 0.004], ["Caja B-1 x 5 lt", 1]]},
        {"kind": "donlalo_800ml", "ins": [["Botella de 800ml - Don Lalo", 12], ["Tapa dosif. N° 26 blanco / Dorado", 0.012], ["Caja Don Lalo x 800ml x 12 und", 1]]},
        {"kind": "donlalo_20lt", "ins": [["Balde Don Lalo x 20lt", 1], ["TAAAAPA BALDE DON LALO", 1]]},
        {"kind": "belini_200ml", "ins": [["Botella Belini x 200 ml", 24], ["Tapa Tapon 26mm (200ml)", 0.024], ["Caja Belini x 200 ml", 1]]},
        {"kind": "belini_500ml", "ins": [["Botella Belini x 500 ml", 12], ["Tapa dosif. N° 26 blanco / Dorado", 0.012], ["Caja Belini x 500 ml", 1]]},
        {"kind": "belini_900ml", "ins": [["Botella Belini x 900 ml", 12], ["Tapa dosif. N° 26 blanco / Dorado", 0.012], ["Caja Belini x 900 ml", 1]]},
        {"kind": "belini_1lt", "ins": [["Botella Belini x 1 Lt", 12], ["Tapa dosif. N° 26 blanco / Dorado", 0.012], ["CAJA BELINI X 1 LITRO", 1]]},
        {"kind": "belini_2lt", "ins": [["Galonera Belini x 2 lt", 6], ["Tapa color Rojo 2lt", 0.006], ["Caja Belini x 2 lt", 1]]},
        {"kind": "belini_3lt", "ins": [["Botella Belini x 3 lt", 4], ["Tapa color Celeste 3lt", 0.004], ["Asas plasticas color celeste pico 45", 0.004], ["Caja BELINI X 3 LITROS", 1]]},
        {"kind": "belini_5lt", "ins": [["Galonera Belini x 5 lt", 4], ["Tapa color rojo 5lt", 0.004], ["Caja Belini x 5 lt", 1]]},
        {"kind": "belini_lata18lt", "ins": [["Lata Belini 18lt", 1]]},
        {"kind": "belini_balde18lt", "ins": [["Balde Belini x 18 lt", 1], ["Tapa BALDE BELINI color amarillo", 1]]}
      ]';
    BEGIN
      FOR r IN SELECT jsonb_array_elements(insumos_arr) e LOOP
        INSERT INTO recetas (producto_key, version, vigente_desde, vigente_hasta, activa, created_by, observaciones)
        VALUES (r.e->>'kind', 1, CURRENT_DATE, NULL, true, 'seed', 'Receta inicial migrada de la fórmula anterior')
        RETURNING id INTO receta_id;
        FOR ins IN SELECT * FROM jsonb_array_elements(r.e->'ins') WITH ORDINALITY AS t(i, ord) LOOP
          INSERT INTO receta_insumos (receta_id, insumo_nombre, cantidad_por_caja, unidad_medida, obligatorio, orden, notas)
          VALUES (receta_id, ins.i->>0, (ins.i->>1)::numeric, 'UNIDADES', true, ins.ord - 1, NULL);
        END LOOP;
      END LOOP;
    END $$;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DELETE FROM recetas WHERE created_by = 'seed';`);
};