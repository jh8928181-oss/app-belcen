/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  // ===== PRODUCTO TERMINADO - Presentaciones =====
  const productosTerminados = [
    ['b1_200ml', 'Aceite de Soya B-1 200 ml'],
    ['b1_500ml', 'Aceite de Soya B-1 500 ml'],
    ['b1_900ml', 'Aceite de Soya B-1 900 ml'],
    ['b1_1lt', 'Aceite de Soya B-1 1 Lt'],
    ['b1_2lt', 'Aceite de Soya B-1 2 Lt'],
    ['b1_5lt', 'Aceite de Soya B-1 5 Lt (Galonera)'],
    ['donlalo_800ml', 'Aceite de Soya Don Lalo 800 ml'],
    ['donlalo_20lt', 'Aceite de Soya Don Lalo Balde 20 Lt'],
    ['belini_200ml', 'Aceite de Soya Belini 200 ml'],
    ['belini_500ml', 'Aceite de Soya Belini 500 ml'],
    ['belini_900ml', 'Aceite de Soya Belini 900 ml'],
    ['belini_1lt', 'Aceite de Soya Belini 1 Lt'],
    ['belini_2lt', 'Aceite de Soya Belini 2 Lt (Galonera)'],
    ['belini_3lt', 'Aceite de Soya Belini 3 Lt'],
    ['belini_5lt', 'Aceite de Soya Belini 5 Lt (Galonera)'],
    ['belini_lata18lt', 'Aceite de Soya Belini Lata 18 Lt'],
    ['belini_balde18lt', 'Aceite de Soya Belini Balde 18 Lt']
  ];

  for (const [key, nombre] of productosTerminados) {
    pgm.sql(`
      INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas)
      VALUES ('${key}', '${nombre}', 0)
      ON CONFLICT (producto_key) DO NOTHING;
    `);
  }

  // ===== STOCK INSUMOS REFINADO - Insumos base =====
  const insumosRefinado = [
    ['TONSIL OPTIMUN 363', 'KG'],
    ['TONSIL SUPREME 169', 'KG'],
    ['ACIDO FOSFORICO', 'KG'],
    ['SODA EN SOLUCION AL 50%', 'KG'],
    ['SAL', 'KG'],
    ['MANGAS FILTRANTES', 'UND'],
    ['TELA (para filtro prensa)', 'UND']
  ];

  for (const [nombre, um] of insumosRefinado) {
    pgm.sql(`
      INSERT INTO stock_insumos_refinado (nombre, um, stock, estado)
      VALUES ('${nombre}', '${um}', 0, 'STOCK SUFICIENTE')
      ON CONFLICT (nombre) DO NOTHING;
    `);
  }

  // ===== PROVEEDORES - Migración de categorías (idempotente) =====
  pgm.sql(`
    UPDATE proveedores
    SET categoria = 'CAJAS'
    WHERE LOWER(BTRIM(categoria)) = 'embalajes';
  `);
  pgm.sql(`
    UPDATE proveedores
    SET categoria = 'PREFORMAS Y SERVICIOS'
    WHERE LOWER(BTRIM(categoria)) = 'servicios';
  `);
  pgm.sql(`
    UPDATE proveedores
    SET categoria = 'General'
    WHERE LOWER(BTRIM(categoria)) IN ('materia prima', 'otros');
  `);

  // ===== USUARIOS REFINADO (se crean via SEED_PWD_* en script aparte) =====
  // Nota: Los usuarios se crean con el script scripts/seed-dev.js usando variables de entorno
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  // Eliminar datos de semilla (cuidado: solo si no hay datos reales)
  pgm.sql(`DELETE FROM producto_terminado WHERE producto_key IN (
    'b1_200ml','b1_500ml','b1_900ml','b1_1lt','b1_2lt','b1_5lt',
    'donlalo_800ml','donlalo_20lt',
    'belini_200ml','belini_500ml','belini_900ml','belini_1lt','belini_2lt','belini_3lt','belini_5lt','belini_lata18lt','belini_balde18lt'
  );`);

  pgm.sql(`DELETE FROM stock_insumos_refinado WHERE nombre IN (
    'TONSIL OPTIMUN 363','TONSIL SUPREME 169','ACIDO FOSFORICO',
    'SODA EN SOLUCION AL 50%','SAL','MANGAS FILTRANTES','TELA (para filtro prensa)'
  );`);

  // No revertir migración de categorías de proveedores (pérdida de información)
};