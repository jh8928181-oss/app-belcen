// Los servicios de soplado (SAUÑE, B&M DYLPLAST) dejan de mezclarse con las
// preformas fisicas: pasan a la categoria 'SERVICIOS DE SOPLADO'.
// El stock de almacen y el inventario del dashboard solo muestran preformas;
// los servicios viven en su propio cuadro ('Estados de servicio de soplado')
// con logica aparte. La regla es por nombre (empieza con SERVICIO) dentro de
// la categoria vieja, asi los futuros servicios caen solos si se crean con
// ese nombre.

export const up = (pgm) => {
  pgm.sql(`
    UPDATE inventario
    SET categoria = 'SERVICIOS DE SOPLADO'
    WHERE LOWER(BTRIM(categoria)) = 'preformas y servicios'
      AND LOWER(BTRIM(nombre)) LIKE 'servicio%';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    UPDATE inventario
    SET categoria = 'PREFORMAS Y SERVICIOS'
    WHERE categoria = 'SERVICIOS DE SOPLADO';
  `);
};
