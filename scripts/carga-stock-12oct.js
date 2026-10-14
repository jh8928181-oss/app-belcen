require('dotenv').config();

/**
 * Carga al inventario las cantidades del Excel de stock del 12-Oct.
 *
 * - Los SERVICIO* van a 'SERVICIOS DE SOPLADO' (saldos de maquila en poder
 *   de SAUÑE/B&M), no como preformas físicas.
 * - Por defecto es DRY-RUN: muestra lo que haría sin escribir nada.
 * - Con --aplicar escribe (UPDATE + estado + historial de auditoría).
 * - Los no encontrados solo se INSERTAN con --crear-faltantes (para no
 *   duplicar artículos que existen con otro nombre).
 *
 * Uso:
 *   node scripts/carga-stock-12oct.js                  (ver plan)
 *   node scripts/carga-stock-12oct.js --aplicar        (aplicar)
 *   node scripts/carga-stock-12oct.js --aplicar --crear-faltantes
 */
const pool = require('../db');

// [nombre Excel, cantidad, unidad, categoría]
const FILAS = [
  // ---- Botellas, galoneras, latas y baldes ----
  ['Botella de 200 ml - B-1', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 500 ml - B-1', 9946, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 900 ml - B-1', 2296, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 1 Lt - B-1', 19386, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 2 Lt - B-1', 5, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera B-1 x 5 lt', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella de 800ml - Don Lalo', 1308, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 3 Lt', 52, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 200 ml', 22555, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 500 ml', 6721, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 900 ml', 15279, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Belini x 1 Lt', 3558, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Lata Belini 18lt', 699, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera Belini x 2lt', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Galonera Belini x 5lt', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Balde Belini x 18 lt', 0, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Balde Don Lalo x 20lt', 290, 'BALDE', 'BOTELLAS Y GALONERAS'],
  ['Botella VEGA x 900 ml', 20276, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella TIMONEL x 900 ml', 22215, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Fernandez x 1 lt', 32068, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  ['Botella Faisan x 900 ML', 25898, 'UNIDADES', 'BOTELLAS Y GALONERAS'],
  // ---- Cajas ----
  ['Caja B-1 x 200 ml', 948, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 500 ml', 14182, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 900 ml', 69750, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 1 Lt', 16065, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 2 Lt', 1828, 'UNIDADES', 'CAJAS'],
  ['Caja B-1 x 5 Lt', 2087, 'UNIDADES', 'CAJAS'],
  ['Caja Don Lalo x 800ml x 12 und', 20824, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 200 ml', 4497, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 500 ml', 32141, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 900 ml', 15004, 'UNIDADES', 'CAJAS'],
  ['CAJA BELINI X 1 LITRO', 4202, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 2 lt', 1247, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 5 lt', 3053, 'UNIDADES', 'CAJAS'],
  ['Caja Belini x 3 LITROS', 4079, 'UNIDADES', 'CAJAS'],
  ['CAJA TIMONEL 900ML X 12 UND', 1859, 'UNIDADES', 'CAJAS'],
  ['Caja FERNANDEZ X 1 lt', 3960, 'UNIDADES', 'CAJAS'],
  ['CAJA ACEITE VEGA 900ML X 12 UND', 3987, 'UNIDADES', 'CAJAS'],
  // ---- Tapas y asas ----
  ['Tapa dosif. N.° 28 blanco / Dorado', 2.10, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Asas plasticas /Dorado (2LT)', 4.00, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color Rojo 2lt', 2.20, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Tapon 26mm (200ml)', 44.06, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Dosif. N.° 26 blanco / ROJO', 49.92, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa Dosif. N.° 26 blanco / VERDE', 24.46, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color Celeste 3lt', 6.30, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Asas plasticas color celeste pico 45', 6.30, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['Tapa color dorado 5lt', 0.57, 'MILL', 'TAPAS Y ACCESORIOS'],
  ['TAPA BALDE BELINI color amarillo', 0, 'UNIDADES', 'TAPAS Y ACCESORIOS'],
  ['TAPA BALDE DON LALO', 0, 'UNIDADES', 'TAPAS Y ACCESORIOS'],
  ['Tapa Dosif. N.° 26 blanco / Dorado', 3.48, 'MILL', 'TAPAS Y ACCESORIOS'],
  // ---- Preformas físicas ----
  ['Preforma cristal 21 gr. (PICO 26MM)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 19 gr. (500ML)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 09 gr (200ML)', 50.00, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal 23.5 gr (PICO 26MM)', 61.68, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma 45 GR (2 LT)', 7.10, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal 15 GR (26 MLF - 500ML)', 0, 'MILL', 'PREFORMAS Y SERVICIOS'],
  ['Preforma cristal de 104 gr pico 45mm (3LT)', 5.00, 'MILL', 'PREFORMAS Y SERVICIOS'],
  // ---- Servicios de soplado (saldos en poder del tercero) ----
  ['SERVICIO SOPLADO 1LT-900 ML PREF-23GR (SAUÑE)', 3.14, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO SAUÑE PREFORMA 09 GR (200ML)', 97.11, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO SOPLADO 500 ML PREF-15.5GR (SAUÑE)', 40.00, 'MILL', 'SERVICIOS DE SOPLADO'],
  ['SERVICIO B&M DYLPLAST (PREFORMAS 23.5GR)', 66.26, 'MILL', 'SERVICIOS DE SOPLADO'],
  // ---- Etiquetas ----
  ['Etiqueta couche 90 gr x 200 ml B-1', 1771.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 500 ml B-1', 639.70, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml B-1', 499.13, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 Lt B-1', 108.86, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 2 Lt B-1', 158.29, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 5 lt B-1', 9.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90gr x 800 ml Don Lalo', 15.73, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 200 ml Belini', 89.04, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 500 ml Belini', 284.74, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml Belini', 58.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 Lt Belini', 60.52, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 3 lt Belini', 27.64, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 2 lt Belini', 23.98, 'MILL', 'ETIQUETAS'],
  ['Etiqueta polipropileno blanco x 5 lt Belini', 22.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900ml TIMONEL', 11.00, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml VEGA', 0.10, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 1 Lt FERNANDEZ', 0, 'MILL', 'ETIQUETAS'],
  ['Etiqueta couche 90 gr x 900 ml FAISAN', 0, 'MILL', 'ETIQUETAS']
];

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[º°]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const crearFaltantes = args.includes('--crear-faltantes');

  console.log(`Carga de stock Excel 12-Oct: ${FILAS.length} filas (${aplicar ? 'APLICANDO' : 'DRY-RUN, nada se escribe'}).`);

  const inv = await pool.query('SELECT id, nombre, categoria, stock, unidad_medida FROM inventario');
  const porExacto = new Map();
  const porNorm = new Map();
  for (const r of inv.rows) {
    porExacto.set(String(r.nombre).trim(), r);
    if (!porNorm.has(norm(r.nombre))) porNorm.set(norm(r.nombre), r);
  }

  const plan = [];
  const faltantes = [];
  const idsVistos = new Map();
  for (const [nombre, cantidad, unidad, categoria] of FILAS) {
    const exacto = porExacto.get(String(nombre).trim());
    const aprox = exacto || porNorm.get(norm(nombre));
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
      como: exacto ? 'exacto' : `parecido (Excel: "${nombre}")`,
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
           VALUES ('AJUSTE', 'carga_excel_12oct', $1, $2, $3, $4, $5, $6, 'carga_excel', $7)`,
          [p.nombre, p.id, Math.abs(p.dif), p.dif > 0 ? 'SUMA' : 'RESTA', p.anterior, p.nuevo,
            `Carga de stock Excel 12-Oct: ${p.anterior} -> ${p.nuevo} ${p.unidad}`]
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
           VALUES ('AJUSTE', 'carga_excel_12oct', $1, $2, $3, 'SUMA', 0, $3, 'carga_excel', $4)`,
          [f.nombre, ins.rows[0].id, f.cantidad, `Alta por carga Excel 12-Oct (${f.categoria})`]
        );
        creados += 1;
        console.log(`CREADO [${ins.rows[0].id}] ${f.nombre} | ${f.cantidad} ${f.unidad} | ${f.categoria}`);
      }
    }
    await client.query('COMMIT');
    console.log(`\nListo: ${n} actualizados, ${creados} creados. Revisa Almacén y Auditoría > Historial (origen carga_excel_12oct).`);
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
  // Si main() ya cerró el pool (caminos normales), esto no hace nada malo.
  try { const p = pool.end(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ya cerrado */ }
});
