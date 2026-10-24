const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });

/**
 * Carga al inventario y al producto terminado las cantidades del Excel de
 * stock del 22-Oct.
 *
 * - Los SERVICIO* van a 'SERVICIOS DE SOPLADO' (saldos de maquila en poder
 *   de SAUÑE/B&M), no como preformas físicas.
 * - Producto terminado: se sincroniza TODO el catálogo (21 claves). Los que
 *   no aparecen en el conteo del usuario quedan en 0 cajas.
 * - Por defecto es DRY-RUN: muestra lo que haría sin escribir nada.
 * - Con --aplicar escribe (UPDATE + estado + historial de auditoría).
 * - Los no encontrados solo se INSERTAN con --crear-faltantes (para no
 *   duplicar artículos que existen con otro nombre).
 *
 * Uso:
 *   node scripts/carga-stock-22oct.js                  (ver plan)
 *   node scripts/carga-stock-22oct.js --aplicar        (aplicar)
 *   node scripts/carga-stock-22oct.js --aplicar --crear-faltantes
 */
const pool = require('../db');

// [nombre Excel, cantidad, unidad, categoría]
const FILAS = [
  // ---- Botellas, galoneras, latas y baldes ----
  ['Botella de 200 ml - B-1', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 500 ml - B-1', 3204, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 900 ml - B-1', 19463, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 1 lt - B-1', 110841, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 2 lt - B-1', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera B-1 x 5 lt', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 800 ml - Don Lalo', 35100, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 3 lt', 52, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 200 ml', 9603, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 500 ml', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 900 ml', 33168, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 1 lt', 21153, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Lata Belini 18lt', 699, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera Belini x 2lt', 4, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera Belini x 5lt', 3321, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Balde Belini x 18 lt', 710, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Balde Don Lalo x 20lt', 0, 'BALDE', 'BOTELLAS Y GALONERAS'],
  ['Botella VEGA x 900 ml', 18513, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella TIMONEL x 900 ml', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Fernandez x 1 lt', 32068, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Faisan x 900 ML', 5968, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  // ---- Cajas ----
  ['Caja B-1 x 200 ml', 948, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 500 ml', 13620, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 900 ml', 69235, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 1 lt', 49850, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 2 lt', 1739, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 5 lt', 2087, 'UNIDADES', 'CAJAS'],
  ['Caja Don Lalo x 800ml x 12 und', 16062, 'UNIDADES', 'CAJAS'],
  ['Caja Faisan 900 ml x 12 und', 1000, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 200 ml', 3294, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 500 ml', 31713, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 900 ml', 33679, 'UNIDADES', 'CAJAS'],
  ['CAJA BELINI X 1 LTRO', 13039, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 2 lt', 1061, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 5 lt', 2828, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 3 LITROS', 4079, 'UNIDADES', 'CAJAS'],
  ['CAJA TIMONEL 900ML X 12 UND', 9, 'UNIDADES', 'CAJAS'],
  ['Caja FERNANDEZ x 1 lt', 3960, 'UNIDADES', 'CAJAS'],
  ['CAJA ACEITE VEGA 900ML X 12 UND', 2295, 'UNIDADES', 'CAJAS'],
  // ---- Tapas y asas ----
  ['Tapa dosif. N° 28 blanco / Dorado', 2.10, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Asas plasticas /Dorado (2LT)', 4.00, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color Rojo 2lt', 1.67, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Tapon 26mm (200ml)', 72.53, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Dosif. N° 26 blanco / ROJO', 29.62, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Dosif. N° 26 blanco / VERDE', 2.26, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color Celeste 3lt', 6.30, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Asas plasticas color celeste pico 45', 6.30, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color dorado 5lt', 3.33, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa BALDE BELINI color amarillo', 710, 'UNIDADES', 'TAPAS Y ACCESORIOS'],
  ['TAPA BALDE DON LALO', 0, 'UNIDADES', 'TAPAS Y ACCESORIOS'],
  ['Tapa dosif. N° 26 blanco / Dorado', 438.34, 'MILL', 'TAPAS Y ACCESORIOS'],
  // ---- Preformas físicas ----
  ['Preforma cristal 21 gr (PICO 26MM)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 19 gr (500ML)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 09 gr (200ML)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal 23.5 gr (PICO 26MM)', 68.00, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma 45 GR (2 LT)', 7.10, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal 15 GR (26 MLL - 500ML)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 104 gr pico 45mm (3LT)', 5.00, 'MILL', 'PREFORMAS Y SERVICIOS'],
  // ---- Servicios de soplado (saldos en poder del tercero) ----
  ['SERVICIO SOPLADO 1LT-900 ML PREF-23GR (SAUÑE)', 15.25, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO SAUÑE PREFORMA 09 GR (200ML)', 81.19, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO SOPLADO 500 ML PREF-15.5GR (SAUÑE)', 40.00, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO B&M DYLPLAST (PREFORMAS 23GR)', 90.32, 'MILL', 'SERVICIOS DE SOPLADO'],
  // ---- Etiquetas ----
  ['Etiqueta couche 90 gr x 200 ml B-1', 1751.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 500 ml B-1', 639.70, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml B-1', 499.13, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 lt B-1', 38.93, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 2 lt B-1', 158.29, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 5 lt B-1', 9.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90gr x 800 ml Don Lalo', 6.87, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 200 ml Belini', 69.04, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 500 ml Belini', 244.74, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml Belini', 0.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 lt Belini', 107.26, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 3 lt Belini', 27.64, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 2 lt Belini', 23.98, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 5 lt Belini', 22.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900ml TIMONEL', 11.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml VEGA', 0, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 lt FERNANDEZ', 0, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900ml FAISAN', 0, 'MILL', 'ETIQUETAS']
];

// Conteo manual de producto terminado en CAJAS (22-Oct). El catálogo completo
// va a propósito: lo que el usuario no listó queda en 0.
const PT_CAJAS = {
  b1_200ml: 0,
  b1_500ml: 560,
  b1_900ml: 3,
  b1_1lt: 112,
  b1_2lt: 0,
  b1_5lt: 0,
  donlalo_800ml: 2,
  donlalo_20lt: 0,
  belini_200ml: 0,
  belini_500ml: 0,
  belini_900ml: 4,
  belini_1lt: 430,
  belini_2lt: 0,
  belini_3lt: 0,
  belini_5lt: 0,
  belini_lata18lt: 322,
  belini_balde18lt: 100,
  vega_900ml: 0,
  timonel_900ml: 491,
  fernandez_1lt: 62,
  faisan_900ml: 23
};

const TILDES = new RegExp('[\\u0300-\\u036f]', 'g');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(TILDES, '')
    .replace(/[^a-z0-9]/g, '');
}

// Equivalencias confirmadas (typos del Excel o de la base): norma -> id.
const ALIAS_EXCEL_A_ID = {};
function aliasDe(excelNombre, id) {
  ALIAS_EXCEL_A_ID[norm(excelNombre)] = id;
}
aliasDe('TAPA BALDE DON LALO', 47);                                   // 'TAAAAPA...' en la base
aliasDe('Preforma 45 GR (2 LT)', 52);                                 // '44 GR' en la base
aliasDe('Preforma cristal 15 GR (26 ML - 500ML)', 53);                // por si el Excel trae '26 ML'
aliasDe('SERVICIO SOPLADO 1LT-900 ML PREF-23GR (SAUÑE)', 48);         // 'SERVICIO SAUÑE (1LT-900ML)'
aliasDe('SERVICIO SAUÑE PREFORMA DE 09 GR (200ML)', 49);              // por si el Excel trae 'DE'
aliasDe('SERVICIO SOPLADO 500 500ML PREF-15.5GR (SAUÑE)', 54);        // por si el Excel trae '500 500ML'
aliasDe('SERVICIO B&M DYLPLAST (PREFORMAS 23GR)', 56);                // '23.5GR' en la base
aliasDe('CAJA BELINI X 1 LTRO', 29);                                  // '1 LITRO' en la base
aliasDe('Etiqueta couche 90 gr x 900ml TIMONEL', 74);
aliasDe('Etiqueta couche 90 gr x 900 ml VEGA', 75);
aliasDe('Etiqueta couche 90 gr x 900ml FAISAN', 99);

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const crearFaltantes = args.includes('--crear-faltantes');

  console.log(`Carga de stock Excel 22-Oct: ${FILAS.length} filas de inventario + ${Object.keys(PT_CAJAS).length} de producto terminado (${aplicar ? 'APLICANDO' : 'DRY-RUN, nada se escribe'}).`);

  const inv = await pool.query('SELECT id, nombre, categoria, stock, unidad_medida FROM inventario');
  const porExacto = new Map();
  const porNorm = new Map();
  const porId = new Map();
  for (const r of inv.rows) {
    porExacto.set(String(r.nombre).trim(), r);
    porId.set(r.id, r);
    if (!porNorm.has(norm(r.nombre))) porNorm.set(norm(r.nombre), r);
  }

  const plan = [];
  const faltantes = [];
  const idsVistos = new Map();
  for (const [nombre, cantidad, unidad, categoria] of FILAS) {
    const exacto = porExacto.get(String(nombre).trim());
    const aliasId = ALIAS_EXCEL_A_ID[norm(nombre)];
    const porAlias = aliasId !== undefined ? porId.get(aliasId) : null;
    const aprox = exacto || porAlias || porNorm.get(norm(nombre));
    const como = exacto ? 'exacto' : (porAlias ? `alias id ${aliasId}` : `parecido (Excel: "${nombre}")`);
    if (!aprox) {
      faltantes.push({ nombre, cantidad, unidad, categoria });
      continue;
    }
    if (idsVistos.has(aprox.id)) {
      console.log(`AVISO: "${nombre}" cae al mismo artículo que "${idsVistos.get(aprox.id)}" (id ${aprox.id}): solo se aplicará la última fila. Revísalo.`);
    }
    idsVistos.set(aprox.id, nombre);
    const anterior = Number(aprox.stock) || 0;
    const dif = Math.round(((Number(cantidad) - anterior) + Number.EPSILON) * 100) / 100;
    plan.push({
      id: aprox.id,
      nombre: aprox.nombre,
      como,
      anterior,
      nuevo: Number(cantidad),
      unidad,
      unidadAntes: aprox.unidad_medida,
      categoriaAntes: aprox.categoria,
      categoria: aprox.categoria || categoria,
      dif
    });
  }

  const pt = await pool.query('SELECT producto_key, nombre_producto, stock_cajas FROM producto_terminado');
  const ptPorKey = new Map(pt.rows.map(r => [r.producto_key, r]));
  const planPt = [];
  const ptFaltantes = [];
  for (const [key, cajas] of Object.entries(PT_CAJAS)) {
    const fila = ptPorKey.get(key);
    if (!fila) { ptFaltantes.push(key); continue; }
    const anterior = Number(fila.stock_cajas) || 0;
    const dif = Math.round(((Number(cajas) - anterior) + Number.EPSILON) * 100) / 100;
    planPt.push({ key, nombre: fila.nombre_producto, anterior, nuevo: Number(cajas), dif });
  }

  let sinCambios = 0;
  for (const p of plan) {
    const marca = p.dif === 0 ? '=' : (p.dif > 0 ? '+' : '');
    if (p.dif === 0) sinCambios += 1;
    console.log(`${p.dif === 0 ? 'IGUAL ' : 'AJUSTE'} [${p.id}] ${p.nombre} | ${p.anterior} -> ${p.nuevo} ${p.unidad} (${marca}${p.dif}) | ${p.como}`);
  }
  console.log(`\nInventario: ${plan.length} encontrados (${sinCambios} sin cambios), ${faltantes.length} no encontrados.`);
  if (faltantes.length) {
    console.log('NO ENCONTRADOS (revísalos a mano, no se tocan sin --crear-faltantes):');
    for (const f of faltantes) console.log(`  - "${f.nombre}" | ${f.cantidad} ${f.unidad} | iría a ${f.categoria}`);
  }

  console.log('\n--- PRODUCTO TERMINADO (cajas) ---');
  let sinCambiosPt = 0;
  for (const p of planPt) {
    const marca = p.dif === 0 ? '=' : (p.dif > 0 ? '+' : '');
    if (p.dif === 0) sinCambiosPt += 1;
    console.log(`${p.dif === 0 ? 'IGUAL ' : 'AJUSTE'} ${p.key} (${p.nombre}) | ${p.anterior} -> ${p.nuevo} cajas (${marca}${p.dif})`);
  }
  console.log(`Producto terminado: ${planPt.length} encontrados (${sinCambiosPt} sin cambios), ${ptFaltantes.length} claves no existen en la BD.`);
  if (ptFaltantes.length) console.log('  Claves inexistentes: ' + ptFaltantes.join(', '));

  if (!aplicar) {
    console.log('\nDRY-RUN: nada escrito. Relee el plan y corre con --aplicar.');
    if (crearFaltantes) console.log('(nota: --crear-faltantes solo vale junto a --aplicar)');
    await pool.end();
    return;
  }

  console.log('\nAplicando en transacción...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const p of plan) {
      if (p.dif === 0 && (p.unidadAntes || 'UNIDADES') === p.unidad) continue;
      await client.query('UPDATE inventario SET stock = $1, unidad_medida = $2 WHERE id = $3', [p.nuevo, p.unidad, p.id]);
      await client.query(
        "UPDATE inventario SET estado = CASE WHEN stock <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END WHERE id = $1",
        [p.id]
      );
      if (p.dif !== 0) {
        await client.query(
          `INSERT INTO historial_inventario (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
           VALUES ('AJUSTE', 'carga_excel_22oct', $1, $2, $3, $4, $5, $6, 'carga_excel', $7)`,
          [p.nombre, p.id, Math.abs(p.dif), p.dif > 0 ? 'SUMA' : 'RESTA', p.anterior, p.nuevo,
            `Carga de stock Excel 22-Oct: ${p.anterior} -> ${p.nuevo} ${p.unidad}`]
        );
      }
      n += 1;
    }

    let nPt = 0;
    for (const p of planPt) {
      if (p.dif === 0) continue;
      await client.query('UPDATE producto_terminado SET stock_cajas = $1 WHERE producto_key = $2', [p.nuevo, p.key]);
      nPt += 1;
    }

    let creados = 0;
    if (crearFaltantes) {
      for (const f of faltantes) {
        const ins = await client.query(
          'INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [f.nombre, f.categoria, f.cantidad, f.unidad, Number(f.cantidad) <= 0 ? 'REALIZAR PEDIDO' : 'STOCK SUFICIENTE']
        );
        await client.query(
          `INSERT INTO historial_inventario (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
           VALUES ('AJUSTE', 'carga_excel_22oct', $1, $2, $3, 'SUMA', 0, $3, 'carga_excel', $4)`,
          [f.nombre, ins.rows[0].id, f.cantidad, `Alta por carga Excel 22-Oct (${f.categoria})`]
        );
        creados += 1;
        console.log(`CREADO [${ins.rows[0].id}] ${f.nombre} | ${f.cantidad} ${f.unidad} | ${f.categoria}`);
      }
    }
    await client.query('COMMIT');
    console.log(`\nListo: ${n} artículos de inventario actualizados, ${nPt} productos terminados actualizados, ${creados} creados.`);
    console.log('Revisa Almacén, Producto Terminado y Auditoría > Historial (origen carga_excel_22oct).');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error, nada se escribió:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  try { const p = pool.end(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ya cerrado */ }
});
