// Stock al 7-Oct segun el STOCK DIARIO VALORIZADO (Excel de planta).
//
// 1. Borra las filas basura de la categoria 'General' que se veian en el
//    stock de almacen (ETIQUETA B-1 X 1LT y ETIQUETA BELINI X 1 LT).
// 2. Pone el stock de cada articulo al valor del Excel. El match es por
//    nombre insensible a mayusculas y espacios (LOWER + BTRIM).
// 3. Da de alta los articulos del Excel que no existian en el inventario
//    (Botella TIMONEL/Fernandez/Faisan, Caja FERNANDEZ, Etiqueta FERNANDEZ).
//
// El estado sigue la misma regla del endpoint de ajuste (<= 0 PEDIDO, si no
// SUFICIENTE): el Excel trae umbrales propios por articulo que el sistema no
// modela, asi que esos casos se alinean a la regla del sistema.
//
// Filas del Excel que NO se tocan por nombre ambiguo (aclarar con planta):
//   - 'SERVICIO SOPLADO 1LT-900 ML PREF-23GR (SAUÑE...' 42.00 (nombre cortado)
//   - 'Preforma cristal 09 gr (200ML)' 50.00 (sin match en inventario)
//   - 'Tapa color dorado 5lt' 0.00 (en inventario existe 'Tapa color rojo 5lt')

const VALORES = [
  // [nombre, stock] — BOTELLAS Y GALONERAS (UNIDADES)
  ['Botella de 200 ml - B-1', 0],
  ['Botella de 500 ml - B-1', 9946],
  ['Botella de 900 ml - B-1', 2245],
  ['Botella de 1 Lt - B-1', 0],
  ['Botella de 2 Lt - B-1', 0],
  ['Galonera B-1 x 5 lt', 0],
  ['Botella de 800ml - Don Lalo', 1824],
  ['Botella Belini x 3 lt', 52],
  ['Botella Belini x 200 ml', 0],
  ['Botella Belini x 500 ml', 10645],
  ['Botella Belini x 900 ml', 0],
  ['Botella Belini x 1 Lt', 0],
  ['Lata Belini 18lt', 699],
  ['Galonera Belini x 2 lt', 0],
  ['Galonera Belini x 5 lt', 2000],
  ['Balde Belini x 18 lt', 0],
  ['Balde Don Lalo x 20lt', 690],
  ['Botella VEGA x 900 ml', 20276],
  // CAJAS (UNIDADES)
  ['Caja B-1 x 200 ml', 949],
  ['Caja B-1 x 500 ml', 14182],
  ['Caja B-1 x 900 ml', 71008],
  ['Caja B-1 x 1 lt', 23288],
  ['Caja B-1 x 2 lt', 1965],
  ['Caja B-1 x 5 lt', 2087],
  ['Caja Don Lalo x 800ml x 12 und', 21046],
  ['Caja Belini x 200 ml', 4497],
  ['Caja Belini x 500 ml', 32141],
  ['Caja Belini x 900 ml', 15708],
  ['CAJA BELINI X 1 LITRO', 8184],
  ['Caja Belini x 2 lt', 1247],
  ['Caja Belini x 5 lt', 3553],
  ['Caja BELINI X 3 LITROS', 4079],
  ['CAJA TIMONEL 900ML X 12 UND', 2062],
  ['CAJA ACEITE VEGA 900ML X 12 UND', 3987],
  // TAPAS Y ACCESORIOS (MILL, salvo las dos de balde en UNIDADES)
  ['Tapa dosif. N° 28 blanco / Dorado', 2.10],
  ['Asas plasticas /Dorado (2LT)', 4.00],
  ['Tapa color Rojo 2lt', 3.01],
  ['Tapa Tapon 26mm (200ml)', 44.09],
  ['Tapa Dosif. N° 26 blanco / ROJO', 49.92],
  ['Tapa Dosif. N° 26 blanco / VERDE', 26.89],
  ['Tapa color Celeste 3lt', 6.30],
  ['Asas plasticas color celeste pico 45', 6.30],
  ['Tapa BALDE BELINI color amarillo', 0],
  ['TAAAAPA BALDE DON LALO', 0],
  ['Tapa dosif. N° 26 blanco / Dorado', 30.04],
  // PREFORMAS Y SERVICIOS (MILL)
  ['Preforma cristal 21 gr (PICO 26MM)', 0],
  ['Preforma cristal de 26.3 GR (PICO 28MM)', 0],
  ['Preforma 45 GR (2 LT)', 0],
  ['Preforma cristal 15 GR (26 MLL - 500ML)', 0],
  ['SERVICIO SOPLADO 500 ML PREF-15.5GR (SAUÑE)', 40.00],
  ['Preforma cristal de 104 gr pico 45mm (3LT)', 5.00],
  ['SERVICIO B&M DYLPLAST (PREFORMAS 23.5GR)', 94.16],
  ['Preforma cristal 23.5 gr (PICO 26MM)', 28.00],
  ['SERVICIO SAUÑE PREFORMA 09 GR (200ML)', 82.38],
  // ETIQUETAS (MILL)
  ['Etiqueta couche 90 gr x 200 ml B-1', 1771.00],
  ['Etiqueta couche 90 gr x 500 ml B-1', 639.70],
  ['Etiqueta couche 90 gr x 900 ml B-1', 519.13],
  ['Etiqueta couche 90 gr x 1 lt B-1', 183.47],
  ['Etiqueta couche 90 gr x 2 lt B-1', 159.19],
  ['Etiqueta polipropileno blanco x 5 lt B-1', 9.00],
  ['Etiqueta couche 90gr x 800 ml Don Lalo', 106.66],
  ['Etiqueta couche 90 gr x 200 ml Belini', 89.04],
  ['Etiqueta couche 90 gr x 500 ml Belini', 284.74],
  ['Etiqueta couche 90 gr x 900 ml Belini', 88.00],
  ['Etiqueta couche 90 gr x 1 lt Belini', 37.83],
  ['Etiqueta polipropileno blanco x 3 lt Belini', 27.64],
  ['Etiqueta polipropileno blanco x 2 lt Belini', 23.98],
  ['Etiqueta polipropileno blanco x 5 lt Belini', 22.00],
  ['Etiqueta couche 90 gr x 900ml TIMONEL', 11.00],
  ['Etiqueta couche 90 gr x 900 ml VEGA', 0.10]
];

// [nombre, categoria, unidad_medida, stock] — altas que no existian.
const NUEVOS = [
  ['Botella TIMONEL x 900 ml', 'BOTELLAS Y GALONERAS', 'UNIDADES', 24651],
  ['Botella Fernandez x 1 lt', 'BOTELLAS Y GALONERAS', 'UNIDADES', 32068],
  ['Botella Faisan x 1 lt', 'BOTELLAS Y GALONERAS', 'UNIDADES', 13522],
  ['Caja FERNANDEZ x 1 lt', 'CAJAS', 'UNIDADES', 3960],
  ['Etiqueta couche 90 gr x 1 lt FERNANDEZ', 'ETIQUETAS', 'MILL', 0.00]
];

const esc = (s) => String(s).replace(/'/g, "''");

export const up = (pgm) => {
  pgm.sql(`
    DELETE FROM inventario
    WHERE LOWER(BTRIM(categoria)) IN ('general', 'sin categoría', 'sin categoria')
       OR LOWER(BTRIM(nombre)) IN ('etiqueta b-1 x 1lt', 'etiqueta belini x 1 lt');
  `);

  for (const [nombre, stock] of VALORES) {
    pgm.sql(`
      UPDATE inventario
      SET stock = ${stock},
          estado = CASE WHEN ${stock} <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END
      WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM('${esc(nombre)}'));
    `);
  }

  for (const [nombre, categoria, unidad, stock] of NUEVOS) {
    const estado = stock <= 0 ? 'REALIZAR PEDIDO' : 'STOCK SUFICIENTE';
    pgm.sql(`
      INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado)
      SELECT '${esc(nombre)}', '${esc(categoria)}', ${stock}, '${esc(unidad)}', '${estado}'
      WHERE NOT EXISTS (
        SELECT 1 FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM('${esc(nombre)}'))
      );
    `);
  }
};

export const down = () => {
  // Migracion de datos del Excel: no hay como devolver los valores
  // anteriores automaticamente. Revertirla es re-cargar el stock anterior.
};
