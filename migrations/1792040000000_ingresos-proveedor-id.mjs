// El proveedor de un ingreso de almacén vivía como texto libre pegado a la
// guía (y salía duplicado: "EUROPLAST" vs "EUROPLAST SAC"), así que los
// ingresos no se podían separar por proveedor contra el catálogo de la Base
// de Datos General. Pasa a columna propia proveedor_id con FK a proveedores
// (ON DELETE SET NULL: si se da de baja un proveedor del catálogo, el ingreso
// conserva su texto) y se rellena lo histórico con la misma regla que las
// guías contra las órdenes (normalizado; gana el exacto, y si no solo un
// candidato contenido de ≥5 caracteres: nunca adivinar entre varios).
const SQL_NORM = String.raw`lower(btrim(regexp_replace(translate(coalesce({C}, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUUN'), '\s+', ' ', 'g')))`;

export const up = (pgm) => {
  pgm.addColumns('registro_ingresos_almacen', {
    proveedor_id: { type: 'integer' }
  });

  pgm.addConstraint('registro_ingresos_almacen', 'registro_ingresos_almacen_proveedor_id_fkey', {
    foreignKeys: {
      columns: 'proveedor_id',
      references: 'proveedores(id)',
      onDelete: 'SET NULL'
    }
  });

  const normProveedor = SQL_NORM.replace('{C}', 'r.proveedor');
  const normNombre = SQL_NORM.replace('{C}', 'p.nombre');

  pgm.sql(String.raw`
    WITH norm AS (
      SELECT r.id AS fila_id, ${normProveedor} AS texto
        FROM registro_ingresos_almacen r
       WHERE r.proveedor_id IS NULL
         AND btrim(coalesce(r.proveedor, '')) <> ''
    ), cat AS (
      SELECT p.id, ${normNombre} AS clave
        FROM proveedores p
    ), cand AS (
      SELECT n.fila_id, c.id,
             CASE WHEN c.clave = n.texto THEN 0 ELSE 1 END AS prioridad
        FROM norm n
        JOIN cat c
          ON c.clave = n.texto
          OR (length(c.clave) >= 5 AND length(n.texto) >= 5
              AND (position(n.texto in c.clave) > 0 OR position(c.clave in n.texto) > 0))
    ), elegido AS (
      SELECT fila_id, id FROM (
        SELECT fila_id, id,
               row_number() OVER (PARTITION BY fila_id ORDER BY prioridad, id) AS rn,
               count(*) FILTER (WHERE prioridad = 0) OVER (PARTITION BY fila_id) AS exactos,
               count(*) OVER (PARTITION BY fila_id) AS total
          FROM cand
      ) x
      WHERE rn = 1 AND (exactos > 0 OR total = 1)
    )
    UPDATE registro_ingresos_almacen r
       SET proveedor_id = e.id
      FROM elegido e
     WHERE e.fila_id = r.id;
  `);
};

export const down = (pgm) => {
  pgm.dropConstraint('registro_ingresos_almacen', 'registro_ingresos_almacen_proveedor_id_fkey');
  pgm.dropColumns('registro_ingresos_almacen', ['proveedor_id']);
};
