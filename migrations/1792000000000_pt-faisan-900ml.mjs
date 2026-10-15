// Faisan ya se despacha (la botella y la caja están en el inventario) pero
// nunca existió como producto terminado: las guías que lo traían quedaban
// "sin producto" porque no había clave a la que vincular el renglón.
export const up = (pgm) => {
  pgm.sql(`INSERT INTO producto_terminado (producto_key, nombre_producto, stock_cajas, stock_minimo)
           SELECT 'faisan_900ml', 'Aceite de Soya Faisan 900 ml', 0, 0
           WHERE NOT EXISTS (SELECT 1 FROM producto_terminado WHERE producto_key = 'faisan_900ml')`);
};

export const down = (pgm) => {
  // Solo se retira si nunca se movió stock: si ya hubo producción o salidas,
  // borrarlo dejaría el historial apuntando a una clave inexistente.
  pgm.sql(`DELETE FROM producto_terminado WHERE producto_key = 'faisan_900ml' AND COALESCE(stock_cajas, 0) = 0`);
};
