/**
 * numero_pedido nace vacio: el INSERT no lo trae porque el correlativo
 * PED-YYYY-#### se calcula DESPUES, con el id que devuelve el INSERT, en la
 * misma transaccion. Con NOT NULL y sin default, Postgres rechaza ese INSERT
 * y todo pedido nuevo caia en el catch generico ("No se pudo registrar el
 * pedido"). DROP NOT NULL lo arregla: la fila nunca se commitea sin numero
 * (INSERT y UPDATE van en la misma transaccion) y UNIQUE sigue cubriendo los
 * duplicados (varios NULL no chocan entre si en Postgres).
 */

export const up = (pgm) => {
  pgm.sql('ALTER TABLE pedidos_venta ALTER COLUMN numero_pedido DROP NOT NULL;');
};

export const down = (pgm) => {
  pgm.sql('ALTER TABLE pedidos_venta ALTER COLUMN numero_pedido SET NOT NULL;');
};
