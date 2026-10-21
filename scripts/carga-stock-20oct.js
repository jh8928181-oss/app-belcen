const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });

/**
 * Carga al inventario las cantidades del Excel de stock del 20-Oct.
 *
 * - Los SERVICIO* van a 'SERVICIOS DE SOPLADO' (saldos de maquila en poder
 *   de SAUÑE/B&M), no como preformas físicas.
 * - Por defecto es DRY-RUN: muestra lo que haría sin escribir nada.
 * - Con --aplicar escribe (UPDATE + estado + historial de auditoría).
 * - Los no encontrados solo se INSERTAN con --crear-faltantes (para no
 *   duplicar artículos que existen con otro nombre).
 *
 * Uso:
 *   node scripts/carga-stock-20oct.js                  (ver plan)
 *   node scripts/carga-stock-20oct.js --aplicar        (aplicar)
 *   node scripts/carga-stock-20oct.js --aplicar --crear-faltantes
 */
const pool = require('../db');

// [nombre Excel, cantidad, unidad, categoría]
const FILAS = [
  // ---- Botellas, galoneras, latas y baldes ----
  ['Botella de 200 ml - B-1', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 500 ml - B-1', 9946, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 900 ml - B-1', 18851, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 1 lt - B-1', 77625, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 2 lt - B-1', 5, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera B-1 x 5 lt', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 800 ml - Don Lalo', 22980, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 3 lt', 52, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 200 ml', 9603, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 500 ml', 1585, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 900 ml', 10452, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 1 lt', 16615, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Lata Belini 18lt', 699, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera Belini x 2lt', 4, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera Belini x 5lt', 3801, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Balde Belini x 18 lt', 960, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Balde Don Lalo x 20lt', 283, 'BALDE', 'BOTELLAS Y GALONERAS'],
  ['Botella VEGA x 900 ml', 18513, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella TIMONEL x 900 ml', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Fernandez x 1 lt', 32068, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Faisan x 900 ML', 5968, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  // ---- Cajas ----
  ['Caja B-1 x 200 ml', 948, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 500 ml', 14182, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 900 ml', 69235, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 1 lt', 50462, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 2 lt', 1828, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 5 lt', 2087, 'UNIDADES', 'CAJAS'],
  ['Caja Don Lalo x 800ml x 12 und', 16732, 'UNIDADES', 'CAJAS'],
  ['Caja Faisan 900 ml x 12 und', 1000, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 200 ml', 3294, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 500 ml', 31713, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 900 ml', 34189, 'UNIDADES', 'CAJAS'],
  ['CAJA BELINI X 1 LTRO', 14751, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 2 lt', 1061, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 5 lt', 2948, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 3 LITROS', 4079, 'UNIDADES', 'CAJAS'],
  ['CAJA TIMONEL 900ML X 12 UND', 9, 'UNIDADES', 'CAJAS'],
  ['Caja FERNANDEZ x 1 lt', 3960, 'UNIDADES', 'CAJAS'],
  ['CAJA ACEITE VEGA 900ML X 12 UND', 2295, 'UNIDADES', 'CAJAS'],
  // ---- Tapas y asas ----
  ['Tapa dosif. N° 28 blanco / Dorado', 2.10, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Asas plasticas /Dorado (2LT)', 4.00, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color Rojo 2lt', 2.20, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Tapon 26mm (200ml)', 72.53, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Dosif. N° 26 blanco / ROJO', 29.62, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Dosif. N° 26 blanco / VERDE', 2.26, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color Celeste 3lt', 6.30, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Asas plasticas color celeste pico 45', 6.30, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color dorado 5lt', 4.23, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa BALDE BELINI color amarillo', 960, 'UNIDADES', 'TAPAS Y ACCESORIOS'],
  ['TAPA BALDE DON LALO', 290, 'UNIDADES', 'TAPAS Y ACCESORIOS'],
  ['Tapa dosif. N° 26 blanco / Dorado', 237.13, 'MILL', 'TAPAS Y ACCESORIOS'],
  // ---- Preformas físicas ----
  ['Preforma cristal 21 gr (PICO 26MM)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 19 gr (500ML)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 09 gr. (200 ml)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal 23.5 gr (PICO 26MM)', 85.17, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma 45 GR (2 LT)', 7.10, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal 15 GR (26 ML - 500ML)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 104 gr pico-45mm(3LT)', 5.00, 'MILL', 'PREFORMAS Y SERVICIOS'],
  // ---- Servicios de soplado (saldos en poder del tercero) ----
  ['SERVICIO SOPLADO 1LT-900 ML PREF-23GR (SAUÑE)', 44.66, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO SAUÑE PREFORMA DE 09 GR (200ML)', 81.19, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO SOPLADO 500 500ML PREF-15.5GR (SAUÑE)', 40.00, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO B&M DYLPLAST (PREFORMAS 23GR)', 71.18, 'MILL', 'SERVICIOS DE SOPLADO'],
  // ---- Etiquetas ----
  ['Etiqueta couche 90 gr x 200 ml B-1', 1751.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 500 ml B-1', 639.70, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml B-1', 499.13, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 lt B-1', 94.29, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 2 lt B-1', 158.29, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 5 lt B-1', 9.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90gr x 800 ml Don Lalo', 86.57, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 200 ml Belini', 69.04, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 500 ml Belini', 244.74, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml Belini', 0.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 lt Belini', 122.07, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 3 lt Belini', 27.64, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 2 lt Belini', 23.98, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 5 lt Belini', 22.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900ml TIMONEL', 11.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml VEGA', 0, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 lt FERNANDEZ', 0, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900ml FAISAN', 0, 'MILL', 'ETIQUETAS']
];

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
aliasDe('Preforma cristal 15 GR (26 ML - 500ML)', 53);                // '26 MLL' en la base
aliasDe('SERVICIO SOPLADO 1LT-900 ML PREF-23GR (SAUÑE)', 48);         // 'SERVICIO SAUÑE (1LT-900ML)'
aliasDe('SERVICIO SAUÑE PREFORMA DE 09 GR (200ML)', 49);              // sin 'DE' en la base
aliasDe('SERVICIO SOPLADO 500 500ML PREF-15.5GR (SAUÑE)', 54);        // '500 ML' en la base
aliasDe('SERVICIO B&M DYLPLAST (PREFORMAS 23GR)', 56);                // '23.5GR' en la base
aliasDe('CAJA BELINI X 1 LTRO', 29);                                  // '1 LITRO' en la base
aliasDe('Etiqueta couche 90 gr x 900ml TIMONEL', 74);                 // 'couche 900ml' en la base
aliasDe('Etiqueta couche 90 gr x 900 ml VEGA', 75);                   // 'couche 900 ml' en la base
aliasDe('Etiqueta couche 90 gr x 900ml FAISAN', 99);                  // 'couche 900 ml' en la base

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const crearFaltantes = args.includes('--crear-faltantes');

  console.log(`Carga de stock Excel 20-Oct: ${FILAS.length} filas (${aplicar ? 'APLICANDO' : 'DRY-RUN, nada se escribe'}).`);

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

  let sinCambios = 0;
  for (const p of plan) {
    const marca = p.dif === 0 ? '=' : (p.dif > 0 ? '+' : '');
    if (p.dif === 0) sinCambios += 1;
    console.log(`${p.dif === 0 ? 'IGUAL ' : 'AJUSTE'} [${p.id}] ${p.nombre} | ${p.anterior} -> ${p.nuevo} ${p.unidad} (${marca}${p.dif}) | ${p.como}`);
  }
  console.log(`\nResumen: ${plan.length} encontrados (${sinCambios} sin cambios), ${faltantes.length} no encontrados.`);
  if (faltantes.length) {
    console.log('NO ENCONTRADOS (revísalos a mano, no se tocan sin --crear-faltantes):');
    for (const f of faltantes) console.log(`  - "${f.nombre}" | ${f.cantidad} ${f.unidad} | iría a ${f.categoria}`);
  }

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
           VALUES ('AJUSTE', 'carga_excel_20oct', $1, $2, $3, $4, $5, $6, 'carga_excel', $7)`,
          [p.nombre, p.id, Math.abs(p.dif), p.dif > 0 ? 'SUMA' : 'RESTA', p.anterior, p.nuevo,
            `Carga de stock Excel 20-Oct: ${p.anterior} -> ${p.nuevo} ${p.unidad}`]
        );
      }
      n += 1;
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
           VALUES ('AJUSTE', 'carga_excel_20oct', $1, $2, $3, 'SUMA', 0, $3, 'carga_excel', $4)`,
          [f.nombre, ins.rows[0].id, f.cantidad, `Alta por carga Excel 20-Oct (${f.categoria})`]
        );
        creados += 1;
        console.log(`CREADO [${ins.rows[0].id}] ${f.nombre} | ${f.cantidad} ${f.unidad} | ${f.categoria}`);
      }
    }
    await client.query('COMMIT');
    console.log(`\nListo: ${n} actualizados, ${creados} creados. Revisa Almacén y Auditoría > Historial (origen carga_excel_20oct).`);
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
