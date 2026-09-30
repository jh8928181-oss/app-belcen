export const up = (pgm) => {
  pgm.addColumns('inventario', { stock_minimo: { type: 'integer', notNull: true, default: 0 } });
};

export const down = (pgm) => {
  pgm.dropColumns('inventario', ['stock_minimo']);
};