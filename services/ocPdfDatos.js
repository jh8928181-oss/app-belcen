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
 * Campos de entrega que la OC imprime y que el formulario previo puede rellenar.
 *
 * Esta lista es la unica fuente de verdad de los tres lugares donde aparecen:
 * la validacion del backend, el SELECT de la orden y el formulario. Si se
 * agrega uno aca, aparece en los tres.
 */
const CAMPOS_ENTREGA = ['lugar_entrega', 'fecha_entrega', 'area_solicitante', 'forma_pago', 'horario_recepcion', 'atencion'];
const CAMPOS_EMISOR = ['nombre', 'cargo', 'celular', 'email'];

/**
 * Se queda con los campos indicados que vengan con texto.
 *
 * La regla es "gana lo que trae texto, se conserva lo demas": un override vacio
 * no borra el dato que la orden ya tiene guardado, que es justo lo que
 * necesita un formulario que existe para rellenar huecos.
 */
function textoDe(objeto, campos) {
  const salida = {};
  for (const campo of campos) {
    if (!objeto || objeto[campo] === undefined || objeto[campo] === null) continue;
    const valor = String(objeto[campo]).trim();
    if (valor) salida[campo] = valor;
  }
  return salida;
}

/** Campos de entrega con texto de un objeto (orden o override). */
function camposEntregaDe(objeto) {
  return textoDe(objeto, CAMPOS_ENTREGA);
}

/**
 * Cuentas bancarias que llegan en un override, ya normalizadas.
 *
 * Distinto de la normalizacion del alta de proveedor: alla una cuenta a medio
 * llenar se guarda y se ignora al recibir. Aqui se filtra igual, porque el
 * formulario imprime lo que se ve y una fila vacia en el PDF es un renglon con
 * guiones que el proveedor tendria que adivinar.
 */
function normalizarCuentasBancarias(lista) {
  return (Array.isArray(lista) ? lista : []).map(c => ({
    banco: String(c.banco || '').trim(),
    tipo: String(c.tipo || '').trim(),
    numero: String(c.numero || '').trim(),
    moneda: String(c.moneda || 'PEN').trim().toUpperCase() === 'USD' ? 'USD' : 'PEN',
    titular: String(c.titular || '').trim()
  })).filter(c => c.banco && c.numero);
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
 * Los overrides son los datos que escribio el formulario que se abre antes de
 * imprimir. Manda lo que viene ahi solo si trae texto: el formulario es para
 * rellenar huecos, no para borrar lo que la orden ya tiene guardado. Y no se
 * escribe nada en la base; lo que se escribio, se escribio en ese PDF.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id - Id de la orden.
 * @param {{entrega?:object, emisor?:object, cuentas?:Array}} [overrides]
 * @returns {Promise<null|object>} null si la orden no existe.
 */
async function datosParaOrdenPDF(pool, id, overrides = {}) {
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
  let emisor = { nombre: '', cargo: '', celular: '', email: '' };
  if (login) {
    const usr = await pool.query(
      'SELECT nombre, cargo, celular, email FROM usuarios_sistema WHERE usuario = $1',
      [login]
    );
    if (usr.rows.length) emisor = usr.rows[0];
    if (!emisor.nombre) emisor = { ...emisor, nombre: login };
  }

  const entrega = camposEntregaDe(overrides.entrega);
  return {
    orden: { ...orden.rows[0], ...entrega },
    items: items.rows,
    bancos: overrides.cuentas && overrides.cuentas.length
      ? normalizarCuentasBancarias(overrides.cuentas)
      : bancos.rows,
    emisor: { ...emisor, ...textoDe(overrides.emisor, CAMPOS_EMISOR) }
  };
}

/**
 * Que datos le faltan a la OC, con la etiqueta que usa el formulario.
 *
 * Vive en el servicio y no en la pagina porque el aviso tiene que ser el mismo
 * que la maqueta: si cada uno cuenta los huecos por su cuenta, el formulario
 * dice "falta el cargo" y el PDF lo imprime con guion.
 *
 * Se herein dos casos: la atencion cae al contacto del proveedor y el nombre del
 * emisor cae al login, asi que sin esos dos la OC no sale con guion aunque los
 * campos de la orden esten vacios. Avisar "falta atencion" en una orden que si
 * va a imprimir el contacto del proveedor es hacer perder la confianza en el
 * aviso, y a la segunda vez el usuario deja de leerlo.
 */
const ETIQUETAS_ENTREGA = {
  lugar_entrega: 'Lugar de entrega',
  fecha_entrega: 'Fecha de entrega',
  area_solicitante: 'Área solicitante',
  forma_pago: 'Forma de pago',
  horario_recepcion: 'Horario de recepción',
  atencion: 'Atención a'
};
const ETIQUETAS_EMISOR = {
  nombre: 'Nombre de quien emite',
  cargo: 'Cargo',
  celular: 'Celular del emisor',
  email: 'Correo del emisor'
};

/** Lo que el formulario previo a imprimir necesita, mas la lista de huecos. */
function datosFormularioOC({ orden, bancos, emisor }) {
  const hayTexto = (v) => v !== null && v !== undefined && String(v).trim() !== '';

  const entrega = {};
  for (const campo of CAMPOS_ENTREGA) {
    if (hayTexto(orden[campo])) entrega[campo] = String(orden[campo]).trim();
  }
  const emisorDatos = {};
  for (const campo of CAMPOS_EMISOR) {
    if (hayTexto(emisor && emisor[campo])) emisorDatos[campo] = String(emisor[campo]).trim();
  }

  const faltantes = [];
  for (const campo of CAMPOS_ENTREGA) {
    if (hayTexto(entrega[campo])) continue;
    // La atencion se resuelve con el contacto del proveedor, asi que solo
    // falta de verdad si tampoco hay contacto.
    if (campo === 'atencion' && hayTexto(orden.contacto)) continue;
    faltantes.push({ seccion: 'entrega', campo, etiqueta: ETIQUETAS_ENTREGA[campo] });
  }
  for (const campo of CAMPOS_EMISOR) {
    if (hayTexto(emisorDatos[campo])) continue;
    faltantes.push({ seccion: 'emisor', campo, etiqueta: ETIQUETAS_EMISOR[campo] });
  }
  if (!bancos.length) {
    faltantes.push({ seccion: 'cuentas', campo: 'cuentas', etiqueta: 'Cuentas bancarias del proveedor' });
  }

  return {
    numero: orden.numero,
    proveedor: orden.proveedor_nombre_actual || orden.proveedor_nombre || '',
    entrega,
    emisor: emisorDatos,
    cuentas: bancos,
    faltantes
  };
}

module.exports = {
  datosMoneda, repartirIgv, datosParaOrdenPDF, datosFormularioOC,
  camposEntregaDe, normalizarCuentasBancarias,
  CAMPOS_ENTREGA, CAMPOS_EMISOR
};