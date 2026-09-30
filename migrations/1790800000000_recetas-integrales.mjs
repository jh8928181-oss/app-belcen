/**
 * Recetas integrales: relacion por FK con inventario, BOM anidado, merma,
 * stock de seguridad, productos nuevos y diff de auditoria.
 *
 * - receta_insumos.insumo_id reemplaza la busqueda por texto: el descuento en
 *   produccion usaba LOWER(nombre) = LOWER($1), que no encuentra nombres con
 *   acentos, grados ni puntuacion distinta. Con id no hay ambiguedad.
 * - componente_receta_id permite que una linea sea un sub-ensamblado, que se
 *   expande en cascada al calcular insumos.
 * - cantidad_efectiva es columna generada: PostgreSQL la recalcula sola, asi
 *   que no puede desincronizarse del codigo.
 * - Se suelta la FK producto_key -> producto_terminado para permitir recetas de
 *   productos que todavia no estan en el catalogo.
 */

export const up = (pgm) => {
  // ===== recetas =====
  // addColumn recibe un objeto de columnas, no (tabla, nombre, opciones):
  // con la firma de nombre suelto el nombre se esparce letra por letra.
  pgm.addColumn('recetas', {
    nombre_producto: { type: 'varchar(150)' },
    origen: { type: 'varchar(20)', notNull: true, default: 'producto_terminado' }
  });

  // Se copia el nombre legible antes de soltar la FK, para no perderlo.
  pgm.sql(`
    UPDATE recetas r SET nombre_producto = pt.nombre_producto
    FROM producto_terminado pt WHERE pt.producto_key = r.producto_key
  `);
  pgm.sql('ALTER TABLE recetas DROP CONSTRAINT IF EXISTS recetas_producto_key_fkey;');

  // Una sola receta vigente por producto, garantizado en base de datos y no
  // solo por codigo. Sin esto dos activaciones concurrentes dejan dos vigentes.
  pgm.createIndex('recetas', ['producto_key'], {
    unique: true,
    where: 'activa',
    name: 'uq_receta_vigente_por_producto'
  });
  pgm.createIndex('recetas', ['nombre_producto']);

  // ===== receta_insumos =====
  pgm.addColumn('receta_insumos', {
    insumo_id: { type: 'int' },
    componente_receta_id: { type: 'int' },
    merma_pct: { type: 'numeric(6,3)', notNull: true, default: 0 },
    stock_minimo: { type: 'numeric(12,3)' }
  });

  pgm.sql(`
    ALTER TABLE receta_insumos
    ADD COLUMN cantidad_efectiva NUMERIC(14,6)
    GENERATED ALWAYS AS (cantidad_por_caja * (1 + merma_pct / 100)) STORED
  `);

  pgm.addConstraint('receta_insumos', 'fk_receta_insumo_inventario',
    'FOREIGN KEY (insumo_id) REFERENCES inventario(id)');
  pgm.addConstraint('receta_insumos', 'fk_receta_insumo_subreceta',
    'FOREIGN KEY (componente_receta_id) REFERENCES recetas(id)');
  pgm.addConstraint('receta_insumos', 'chk_merma_en_rango',
    'CHECK (merma_pct >= 0 AND merma_pct < 100)');
  pgm.addConstraint('receta_insumos', 'chk_sin_autorreferencia',
    'CHECK (componente_receta_id IS NULL OR componente_receta_id <> receta_id)');

  pgm.createIndex('receta_insumos', ['insumo_id']);

  // ===== backfill: resolver cada insumo a su fila de inventario =====
  // Se replica utils/helpers.js normalizar(): minusculas sin ° º . ( ) / , - ni espacios.
  pgm.sql(`
    UPDATE receta_insumos ri SET insumo_id = inv.id
    FROM inventario inv
    WHERE ri.insumo_id IS NULL
      AND lower(regexp_replace(inv.nombre, '[°º\\.\\(\\)/,\\-[:space:]]+', '', 'g'))
        = lower(regexp_replace(ri.insumo_nombre, '[°º\\.\\(\\)/,\\-[:space:]]+', '', 'g'))
  `);

  // A partir de aqui el nombre es canonico: lo define el inventario, no el cliente.
  pgm.sql(`
    UPDATE receta_insumos ri SET insumo_nombre = inv.nombre
    FROM inventario inv WHERE ri.insumo_id = inv.id
  `);

  // Toda linea debe ser hoja (insumo) o sub-ensamblado (subreceta), nunca ninguna.
  pgm.addConstraint('receta_insumos', 'chk_linea_con_destino',
    'CHECK (insumo_id IS NOT NULL OR componente_receta_id IS NOT NULL)');
  pgm.addConstraint('receta_insumos', 'chk_cantidad_efectiva_positiva',
    'CHECK (cantidad_por_caja > 0)');

  // ===== auditoria =====
  // El trigger solo ve UPDATE sobre recetas; el diff de la lista de insumos lo
  // escribe la ruta, que es quien sabe la intencion del cambio.
  pgm.addColumn('historial_recetas', { diff: { type: 'jsonb' } });
};

export const down = (pgm) => {
  // Las recetas de productos que no estan en producto_terminado no se pueden
  // volver a colgar de la FK: se elimina su historial en vez de fallar.
  pgm.sql(`
    DELETE FROM historial_recetas h
    WHERE NOT EXISTS (SELECT 1 FROM recetas r WHERE r.id = h.receta_id)
  `);

  pgm.dropColumn('historial_recetas', ['diff']);

  pgm.dropConstraint('receta_insumos', 'chk_cantidad_efectiva_positiva');
  pgm.dropConstraint('receta_insumos', 'chk_linea_con_destino');
  pgm.dropIndex('receta_insumos', ['insumo_id']);
  pgm.dropConstraint('receta_insumos', 'fk_receta_insumo_subreceta');
  pgm.dropConstraint('receta_insumos', 'fk_receta_insumo_inventario');
  pgm.dropConstraint('receta_insumos', 'chk_sin_autorreferencia');
  pgm.dropConstraint('receta_insumos', 'chk_merma_en_rango');
  pgm.sql('ALTER TABLE receta_insumos DROP COLUMN IF EXISTS cantidad_efectiva;');
  pgm.dropColumn('receta_insumos', ['stock_minimo', 'merma_pct', 'componente_receta_id', 'insumo_id']);

  pgm.dropIndex('recetas', ['nombre_producto']);
  pgm.dropIndex('recetas', ['producto_key'], { name: 'uq_receta_vigente_por_producto' });
  pgm.addConstraint('recetas', 'recetas_producto_key_fkey',
    'FOREIGN KEY (producto_key) REFERENCES producto_terminado(producto_key)');
  pgm.dropColumn('recetas', ['origen', 'nombre_producto']);
};
