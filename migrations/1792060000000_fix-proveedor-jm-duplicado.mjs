// El catálogo ya tenía "J & M QUIMICOS Y TECNOLOGIA SAC" (con espacios) y la
// carga del Excel lo trajo como "J&M QUIMICOS Y TECNOLOGIA SAC" (sin
// espacios): al ser nombres distintos el upsert no chocó y salieron dos filas
// con el mismo RUC (20602317260). Fusiona por RUC: se conserva el registro
// original (es el que referencian las órdenes y el stock) y se queda con el
// nombre del Excel; el de la carga se da de baja. El borrado es por ruc
// compartido, así que también cubre cualquier otro duplicado que traiga una
// carga futura.
export const up = (pgm) => {
  pgm.sql(String.raw`
    DELETE FROM proveedores p
     WHERE p.usuario_registro = 'carga-excel'
       AND p.ruc IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM proveedores otra
              WHERE otra.ruc = p.ruc AND otra.id < p.id
           );
  `);
  pgm.sql(String.raw`
    UPDATE ordenes_compras_servicios
       SET proveedor_nombre = 'J&M QUIMICOS Y TECNOLOGIA SAC'
     WHERE proveedor_id = (SELECT id FROM proveedores WHERE nombre = 'J & M QUIMICOS Y TECNOLOGIA SAC');
  `);
  pgm.sql(String.raw`
    UPDATE stock_proveedores
       SET proveedor_nombre = 'J&M QUIMICOS Y TECNOLOGIA SAC'
     WHERE lower(btrim(proveedor_nombre)) = 'j & m quimicos y tecnologia sac';
  `);
  pgm.sql(String.raw`
    UPDATE proveedores
       SET nombre = 'J&M QUIMICOS Y TECNOLOGIA SAC'
     WHERE nombre = 'J & M QUIMICOS Y TECNOLOGIA SAC';
  `);
};

export const down = (pgm) => {
  // Devuelve el nombre con espacios al registro original y rehace la fila de
  // la carga (best effort: si el fusionado ya fue editado o referenciado, el
  // INSERT puede chocar por el nombre y el down queda a medias).
  pgm.sql(String.raw`
    UPDATE ordenes_compras_servicios
       SET proveedor_nombre = 'J & M QUIMICOS Y TECNOLOGIA SAC'
     WHERE proveedor_id = (SELECT id FROM proveedores WHERE nombre = 'J&M QUIMICOS Y TECNOLOGIA SAC');
  `);
  pgm.sql(String.raw`
    UPDATE stock_proveedores
       SET proveedor_nombre = 'J & M QUIMICOS Y TECNOLOGIA SAC'
     WHERE lower(btrim(proveedor_nombre)) = 'j&m quimicos y tecnologia sac';
  `);
  pgm.sql(String.raw`
    UPDATE proveedores
       SET nombre = 'J & M QUIMICOS Y TECNOLOGIA SAC'
     WHERE nombre = 'J&M QUIMICOS Y TECNOLOGIA SAC'
       AND usuario_registro <> 'carga-excel';
  `);
  pgm.sql(String.raw`
    INSERT INTO proveedores (nombre, categoria, ruc, usuario_registro)
    SELECT 'J&M QUIMICOS Y TECNOLOGIA SAC', 'General', '20602317260', 'carga-excel'
     WHERE NOT EXISTS (SELECT 1 FROM proveedores WHERE nombre = 'J&M QUIMICOS Y TECNOLOGIA SAC');
  `);
};
