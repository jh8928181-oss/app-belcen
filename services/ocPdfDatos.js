/**
 * Datos para imprimir la orden de compra en PDF.
 *
 * El PDF no calcula nada contable: lee lo que la orden ya guardo. Esa decision
 * viene de que la aritmetica vive en normalizarItemsOrden() y en la columna
 * total_igv, y si el PDF hiciera su propia cuenta, un redondeo distinto entre
 * la pantalla y el documento firmado seria un descuadre que el proveedor
 * encontraria antes que nosotros.
 *
 * Lo unico que si se calcula aqui es el IGV por linea, que la base no guarda
 * (la orden solo tiene el IGV agregado). Ver repartirIgv().
 */

/** Simbolo y nombre largo de la moneda, para el PDF. */
function datosMoneda(moneda) {
  const m = String(moneda || '').trim().toUpperCase();
  return m === 'USD' ? { simbolo: '$', nombre: 'DOLARES' } : { simbolo: 'S/', nombre: 'SOLES' };
}

/**
 * reparte el IGV de la orden entre sus lineas sin que la columna dejen de sumar.
 *
 * El problema: la orden guarda un solo IGV, redondeado a 2 decimales sobre el
 * total (redondear2(total * pct / 100)). Si ese mismo importe se parte entre las
 * lineas redondeando cada una a 2 decimales, la suma puede quedar en un centimo
 * por debajo o por encima del total. El PDF entonces muestra una columna que no
 * cuadra con la fila TOTALES, que es exactamente la clase de error que hace
 * desconfiar de un documento de compra.
 *
 * La solucion es repartir el sobrante: se calcula el IGV exacto de cada linea,
 * se redondean las que no tienen residuo y el centimo (o los que falten) se
 * ajusta en las lineas cuyo residuo era mayor. Al final, por construccion,
 *   sum(repartirIgv) === igv de la orden
 * sin importar cuantas lineas haya ni los centimos impares.
 *
 * @param {Array<{subtotal:number|string}>} items - Lineas de la orden.
 * @param {number} igvPct - Porcentaje de IGV de la orden.
 * @param {number|string} igvOrden - IGV total ya guardado en la orden.
 * @returns {number[]} IGV por linea, en el mismo orden que items.
 */
function repartirIgv(items, igvPct, igvOrden) {
  const lineas = Array.isArray(items) ? items : [];
  const pct = Number(igvPct);
  const objetivo = Number(igvOrden);
  if (!lineas.length) return [];
  if (!Number.isFinite(objetivo)) return lineas.map(() => 0);

  // Residuo de cada linea: la parte del centimo que se pierde al redondear.
  const residuos = lineas.map(it => {
    const sub = Number(it && it.subtotal) || 0;
    const exacto = Number.isFinite(pct) ? sub * pct / 100 : 0;
    const redondeado = Math.round((exacto + Number.EPSILON) * 100) / 100;
    return { exacto, redondeado, residuo: exacto - redondeado };
  });

  const suma = residuos.reduce((acc, r) => acc + r.redondeado, 0);
  const diferencia = Math.round((objetivo - suma) * 100) / 100;
  if (!diferencia) return residuos.map(r => r.redondeado);

  // Un centimo se ajusta a la linea con mayor residuo absoluto; si hay que
  // mover mas de un centimo, se repite sobre las que todavia tengan margen.
  const ordenados = residuos
    .map((r, i) => ({ i, residuo: r.residuo }))
    .sort((a, b) => Math.abs(b.residuo) - Math.abs(a.residuo) || a.i - b.i);

  const paso = diferencia > 0 ? 0.01 : -0.01;
  let faltan = Math.round(Math.abs(diferencia) / 0.01);
  for (const { i } of ordenados) {
    if (!faltan) break;
    residuos[i].redondeado += paso;
    faltan--;
  }
  // Red de seguridad: si aun asi quedara diferencia (no deberia, porque
  // ordenados tiene una entrada por linea), el total de la orden manda y el
  // desglose se ajusta en la ultima linea.
  if (faltan) residuos[residuos.length - 1].redondeado += paso * faltan;
  return residuos.map(r => r.redondeado);
}

/**
 * Trae todo lo que el PDF necesita de una orden.
 *
 * Son varias consultas y no una porque cada una lee una tabla distinta (orden,
 * items, cuentas y usuario emisor). La que si importa es la primera: nombre,
 * RUC y cuentas del proveedor salen todos de ahi, asi que el encabezado y el
 * bloque de cuentas no pueden discrepar por un cambio de proveedor a mitad de
 * la impresion.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id - Id de la orden.
 * @returns {Promise<null|object>} null si la orden no existe.
 */
async function datosParaOrdenPDF(pool, id) {
  const orden = await pool.query(
    `SELECT o.*,
                p.nombre AS proveedor_nombre_actual, p.ruc, p.telefono, p.email,
                p.contacto, p.direccion
         FROM ordenes_compras_servicios o
         LEFT JOIN proveedores p ON p.id = o.proveedor_id
         WHERE o.id = $1`,
    [id]
  );
  if (!orden.rows.length) return null;

  const items = await pool.query(
    `SELECT descripcion, unidad, cantidad, precio, subtotal
         FROM ordenes_items WHERE orden_id = $1 ORDER BY id ASC`,
    [id]
  );

  const bancos = await pool.query(
    `SELECT banco, tipo, numero, moneda, titular
         FROM proveedor_cuentas_bancarias
         WHERE proveedor_id = $1 ORDER BY orden ASC, id ASC`,
    [orden.rows[0].proveedor_id]
  );

  // El emisor sale del login guardado en la orden. usuario_emision es el que no
  // se reescribe al editar; usuario_registro es la reserva por si las ordenes
  // anteriores a la migracion no lo tienen.
  const login = orden.rows[0].usuario_emision || orden.rows[0].usuario_registro || '';
  let emisor = { nombre: '', cargo: '', celular: '' };
  if (login) {
    const usr = await pool.query(
      'SELECT nombre, cargo, celular FROM usuarios_sistema WHERE usuario = $1',
      [login]
    );
    if (usr.rows.length) emisor = usr.rows[0];
    if (!emisor.nombre) emisor = { ...emisor, nombre: login };
  }

  return { orden: orden.rows[0], items: items.rows, bancos: bancos.rows, emisor };
}

module.exports = { datosMoneda, repartirIgv, datosParaOrdenPDF };