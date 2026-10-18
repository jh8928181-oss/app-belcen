// El numero de lote vivia pegado al textarea de observaciones ("0885 | Tapa:
// ..."), asi que no se podia buscar ni auditar por columna. Pasa a campo
// propio: lo que empieza con un numero (con "Lote" opcional delante) antes
// del '|' o el string entero si era solo numero, se extrae a lote y se limpia
// de la obs. Lo mismo en el detalle ya archivado de
// historial_cierres_produccion.detalle_json (se agrega la clave 'lote' a
// cada item y se quita de su 'obs').
const PATRON = String.raw`^\s*([Ll][Oo][Tt][Ee]:?\s*)?([0-9][0-9 \-]*?)\s*(\||$)([\s\S]*)$`;

export const up = (pgm) => {
  pgm.addColumns('reportes_produccion', {
    lote: { type: 'varchar(100)' }
  });

  // El WHERE repite el patron para no tocar observaciones que no lo siguen;
  // dentro del CASE se protege ademas un m nulo (nunca deberia pasar) para
  // no borrar la obs en vacio.
  pgm.sql(String.raw`
    UPDATE reportes_produccion rp SET lote = btrim(x.m[2]),
           observaciones = CASE
             WHEN x.m IS NULL THEN rp.observaciones
             WHEN x.m[3] = '|' THEN btrim(x.m[4])
             ELSE ''
           END
      FROM (
        SELECT id, regexp_match(observaciones, '${PATRON}') AS m
          FROM reportes_produccion
         WHERE lote IS NULL
           AND observaciones IS NOT NULL
           AND observaciones ~ '${PATRON}'
      ) x
     WHERE rp.id = x.id;
  `);

  pgm.sql(String.raw`
DO $$
DECLARE
  fila RECORD;
  items JSONB;
  nueva JSONB;
  item JSONB;
  m TEXT[];
  obs TEXT;
  resto TEXT;
BEGIN
  FOR fila IN
    SELECT id, detalle_json FROM historial_cierres_produccion
     WHERE detalle_json IS NOT NULL AND ltrim(detalle_json) LIKE '[%'
  LOOP
    BEGIN
      items := fila.detalle_json::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
    IF jsonb_typeof(items) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;
    nueva := '[]'::jsonb;
    FOR item IN SELECT jsonb_array_elements(items)
    LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
        nueva := nueva || jsonb_build_array(item);
        CONTINUE;
      END IF;
      obs := COALESCE(item ->> 'obs', '');
      m := regexp_match(obs, '${PATRON}');
      IF m IS NOT NULL THEN
        resto := CASE WHEN m[3] = '|' THEN btrim(m[4]) ELSE '' END;
        item := item || jsonb_build_object('lote', btrim(m[2]));
        item := item || jsonb_build_object('obs', CASE WHEN resto = '' THEN NULL ELSE resto END);
      END IF;
      nueva := nueva || jsonb_build_array(item);
    END LOOP;
    UPDATE historial_cierres_produccion SET detalle_json = nueva::text WHERE id = fila.id;
  END LOOP;
END $$;
  `);
};

export const down = (pgm) => {
  // La extraccion del lote fuera de observaciones no se puede deshacer con
  // exactitud (se perdio el prefijo original "Lote:" si lo tenia): el down
  // solo devuelve el esquema. Las observaciones limpias siguen siendo
  // legibles y el lote perdido quedaria en la columna hasta que se dropee.
  pgm.dropColumns('reportes_produccion', ['lote']);
};
