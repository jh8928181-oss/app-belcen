// La produccion se abre eligiendo solo el producto y se cierra despues con
// la cantidad producida. Los reportes viejos ya nacieron cerrados con su
// cantidad, asi que el valor por defecto los deja como estan.
export const up = (pgm) => {
  pgm.addColumns('reportes_produccion', {
    estado: { type: 'varchar(20)', notNull: true, default: 'CERRADO' }
  });
  pgm.addConstraint('reportes_produccion', 'reportes_produccion_estado_chk', {
    check: "estado IN ('EN_CURSO', 'CERRADO')"
  });
};

export const down = (pgm) => {
  pgm.dropColumns('reportes_produccion', ['estado']);
};
