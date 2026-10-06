// Precision de stock: de 2 decimales a 6.
//
// El problema: los insumos de recetas y de soplado se consumen en fracciones de
// MILL (0.004, 0.012, 0.024 por caja). Con `numeric(10,2)` la resta se
// redondea al asignarse a la columna y el descuento se pierde entero:
//
//   Tapa dosif. N°26 (0.012/caja) -> descuenta 0.01  (-16.7%)
//   Tapa color celeste 3lt (0.004/caja) -> descuenta 0.00  (-100%)
//
// Las presentaciones de 3lt y 5lt no descontaban ninguna tapa, nunca. Y como el
// historial es mas preciso que el stock que audita (numeric(12,3) contra
// numeric(10,2)), `historial_inventario` affirmaba consumos que el stock jamas
// registro: Auditoria veia 0.004 mientras el stock mostraba 0.00.
//
// numeric(14,6) representa hasta 99,999,999.999999, con holgura para las
// magnitudes reales de la planta. Los CHECK de stock >= 0 se conservan: no se
// cambia la regla, solo la precision con la que se guarda el numero.
//
// `historial_inventario` sube a la misma escala que el stock que audita, para
// que las dos columnas se puedan comparar sin que una redondee a la otra.

export const up = (pgm) => {
  pgm.sql('ALTER TABLE inventario ALTER COLUMN stock TYPE numeric(14,6);');
  pgm.sql('ALTER TABLE stock_insumos_refinado ALTER COLUMN stock TYPE numeric(14,6);');
  pgm.sql('ALTER TABLE historial_inventario ALTER COLUMN cantidad TYPE numeric(14,6);');
  pgm.sql('ALTER TABLE historial_inventario ALTER COLUMN stock_anterior TYPE numeric(14,6);');
  pgm.sql('ALTER TABLE historial_inventario ALTER COLUMN stock_nuevo TYPE numeric(14,6);');
};

export const down = (pgm) => {
  pgm.sql('ALTER TABLE historial_inventario ALTER COLUMN stock_nuevo TYPE numeric(12,3);');
  pgm.sql('ALTER TABLE historial_inventario ALTER COLUMN stock_anterior TYPE numeric(12,3);');
  pgm.sql('ALTER TABLE historial_inventario ALTER COLUMN cantidad TYPE numeric(12,3);');
  pgm.sql('ALTER TABLE stock_insumos_refinado ALTER COLUMN stock TYPE numeric(12,2);');
  pgm.sql('ALTER TABLE inventario ALTER COLUMN stock TYPE numeric(10,2);');
};