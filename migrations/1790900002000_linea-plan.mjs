// Plan de produccion por linea: la secuencia de productos, en orden.
//
// Antes el "siguiente" vivia en estado_lineas.proximo_producto, un varchar de
// texto libre que:
//   - solo guardaba UN producto, no una secuencia, asi que el orden de trabajo
//     de la planta no cabia en el sistema;
//   - no se validaba contra recetas, asi que el dashboard podia mostrar un
//     nombre de producto que no existe;
//   - soplado no tenia ni una pantalla para llenarlo.
//
// linea_plan guarda la secuencia completa y obliga a que cada producto sea una
// receta vigente: si la receta se desactiva, la clave queda huerfana y se ve al
// instante, en vez de mostrar un producto fantasma.
//
// El avance es MANUAL (lo mueve el operario desde la pantalla de su linea), no
// automatico al reportar produccion: un doble clic al reportar no debe correr el
// plan de la planta.
//
// En la practica SOLO envasado usa esta tabla. Soplado fabrica el envase
// (botellas y preformas), que son insumos del inventario y no tienen receta, de
// modo que no existe catalogo contra el cual validar su secuencia: esa linea solo
// publica su estado. El CHECK de area se deja con las dos lineas para no trabar
// el dia que soplado tenga su propio catalogo; la API ya rechaza 'soplado'.
//
// estado_lineas.proximo_producto NO se borra: se deja por compatibilidad y su
// valor se rescata abajo, para no perder lo que el operario ya habia apuntado.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE linea_plan (
      id serial PRIMARY KEY,
      area varchar(20) NOT NULL CHECK (area IN ('envasado','soplado')),
      orden integer NOT NULL CHECK (orden >= 1),
      producto_key varchar(150) NOT NULL,
      usuario_registro varchar(100),
      fecha_actualizacion timestamp NOT NULL DEFAULT (now() at time zone 'utc'),
      UNIQUE (area, orden)
    )`);

  pgm.sql('CREATE INDEX idx_linea_plan_area_orden ON linea_plan (area, orden)');

  // Rescate del dato legado. Solo entra si el texto apunta a una receta vigente:
  // copiar una cadena suelta a la tabla nueva le daria la misma pinta de dato
  // real que se quiere eliminar.
  pgm.sql(`
    INSERT INTO linea_plan (area, orden, producto_key, usuario_registro, fecha_actualizacion)
    SELECT e.area, 1, r.producto_key, e.usuario_registro, e.fecha_actualizacion
    FROM estado_lineas e
    JOIN LATERAL (
      SELECT rec.producto_key
      FROM recetas rec
      WHERE rec.activa IS TRUE
        AND lower(rec.nombre_producto) = lower(e.proximo_producto)
      ORDER BY rec.version DESC
      LIMIT 1
    ) r ON true
    WHERE e.proximo_producto IS NOT NULL
      AND btrim(e.proximo_producto) <> ''`);
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_linea_plan_area_orden');
  pgm.sql('DROP TABLE IF EXISTS linea_plan');
};