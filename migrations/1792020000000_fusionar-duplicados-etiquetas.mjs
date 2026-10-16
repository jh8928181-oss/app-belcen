// La conformidad de la guía T001-0005658 creó 3 etiquetas nuevas porque sus
// nombres no calzaban exactos con el catálogo ("ETIQUETAS BELINI 1LT" en vez
// de "Etiqueta couche 90 gr x 1 lt Belini"). Se absorben en el canónico:
// stock sumado, historial anotado, referencias re-apuntadas y duplicado
// borrado. Los nombres originales de guía se conservan en
// registro_ingresos_almacen.producto_nombre (esa es la historia, no se toca).
export const up = (pgm) => {
  pgm.sql(`DO $$
DECLARE
  par RECORD;
  dup_id INTEGER;
  canon_id INTEGER;
  dup_stock NUMERIC;
  canon_antes NUMERIC;
  canon_nombre TEXT;
BEGIN
  FOR par IN
    SELECT * FROM (VALUES
      ('ETIQUETAS BELINI 1LT', 'Etiqueta couche 90 gr x 1 lt Belini'),
      ('Etiquetas b-1 1lt', 'Etiqueta couche 90 gr x 1 lt B-1'),
      ('Etiquetas don Lalo 800ml', 'Etiqueta couche 90gr x 800 ml Don Lalo')
    ) AS v(dup_nombre, canon_nombre)
  LOOP
    SELECT id, COALESCE(stock, 0) INTO dup_id, dup_stock
      FROM inventario WHERE LOWER(nombre) = LOWER(par.dup_nombre) LIMIT 1;
    IF dup_id IS NULL THEN CONTINUE; END IF;
    SELECT id, COALESCE(stock, 0), nombre INTO canon_id, canon_antes, canon_nombre
      FROM inventario WHERE LOWER(nombre) = LOWER(par.canon_nombre) LIMIT 1;
    IF canon_id IS NULL OR canon_id = dup_id THEN CONTINUE; END IF;

    UPDATE inventario SET stock = COALESCE(stock, 0) + dup_stock WHERE id = canon_id;

    INSERT INTO historial_inventario
      (tipo, origen, producto, articulo_id, cantidad, tipo_cambio,
       stock_anterior, stock_nuevo, usuario, referencia)
    VALUES
      ('ENTRADA', 'fusion_duplicados', canon_nombre, canon_id, dup_stock, 'SUMA',
       canon_antes, canon_antes + dup_stock, 'sistema',
       'Se absorbió el duplicado "' || par.dup_nombre || '" (id ' || dup_id ||
       ') creado por conformidad sin coincidencia exacta');

    UPDATE registro_ingresos_almacen SET articulo_id = canon_id WHERE articulo_id = dup_id;
    UPDATE salidas_almacen SET articulo_id = canon_id WHERE articulo_id = dup_id;
    UPDATE ajustes_pendientes SET articulo_id = canon_id WHERE articulo_id = dup_id;
    UPDATE terceros_preingresos SET articulo_id = canon_id WHERE articulo_id = dup_id;
    UPDATE servicios_envios SET articulo_id = canon_id WHERE articulo_id = dup_id;
    UPDATE servicios_guias SET etiqueta_id = canon_id WHERE etiqueta_id = dup_id;
    UPDATE servicios_guias_items SET etiqueta_id = canon_id WHERE etiqueta_id = dup_id;
    UPDATE receta_insumos SET insumo_id = canon_id WHERE insumo_id = dup_id;
    UPDATE receta_insumo_opciones SET insumo_id = canon_id WHERE insumo_id = dup_id;

    DELETE FROM inventario WHERE id = dup_id;
  END LOOP;
END $$;`);
};

export const down = (pgm) => {
  // Irreversible a propósito: los duplicados ya no existen y su stock vive
  // dentro del canónico. El historial fusion_duplicados cuenta lo que pasó.
  pgm.sql('SELECT 1');
};
