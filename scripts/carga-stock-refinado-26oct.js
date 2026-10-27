const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });

/**
 * Carga al stock de insumos de refinado (Almacén > 🛢️ Refinado) las cantidades
 * de la columna "STOCK EN TAQUE CRUDO" del Excel de control del 26-Oct, junto
 * con la unidad de medida (UM) que viene al lado en esa misma hoja.
 *
 * - El ESTADO no se copia del Excel: en la app se deriva con la regla del
 *   propio módulo (stock <= 0 -> REALIZAR PEDIDO, si no -> STOCK SUFICIENTE),
 *   la misma que usan el endpoint /api/almacen/stock-refinado/ajustar y los
 *   movimientos por lote. La columna OBS del Excel (REALIZAR PEDIDO por días
 *   de cobertura) es un criterio de pedido, no de existencia.
 * - Por defecto es DRY-RUN: muestra lo que haría sin escribir nada.
 * - Con --aplicar escribe (UPDATE de stock/um/estado + historial de auditoría).
 * - Los que no existan en la BD (p. ej. ANTIOXIDANTE o los tanques TK-1/TK-2)
 *   solo se INSERTAN con --crear-faltantes.
 *
 * Uso:
 *   node scripts/carga-stock-refinado-26oct.js                  (ver plan)
 *   node scripts/carga-stock-refinado-26oct.js --aplicar        (aplicar)
 *   node scripts/carga-stock-refinado-26oct.js --aplicar --crear-faltantes
 */
const pool = require('../db');

// [nombre en el Excel, STOCK EN TAQUE CRUDO, UM del Excel]
const FILAS = [
  ['ACEITE CRUDO DE SOYA TK-1', 871.77, 'TM'],
  ['ACEITE CRUDO DE SOYA TK-2', 962.36, 'TM'],
  ['TONSIL OPTIMUN 363', 375.00, 'KG'],
  ['TONSIL SUPREME 169 ( )', 2062.50, 'KG'],
  ['ACIDO FOSFORICO', 808.00, 'KG'],
  ['SODA EN SOLUCION AL 50 %', 530.00, 'KG'],
  ['ANTIOXIDANTE', 0.00, 'KG'],
  ['SAL', 1300.00, 'KG'],
  ['MANGAS FILTRANTES', 15.00, 'UND'],
  ['TELA (para filtro prensa)', 36.00, 'UND']
];

const ORIGEN_HIST = 'carga_stock_refinado_26oct';
const USUARIO = 'carga_stock';

const TILDES = new RegExp('[\\u0300-\\u036f]', 'g');

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(TILDES, '')
    .replace(/[^a-z0-9]/g, '');
}

function estadoDe(stock) {
  return Number(stock) <= 0 ? 'REALIZAR PEDIDO' : 'STOCK SUFICIENTE';
}

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const crearFaltantes = args.includes('--crear-faltantes');

  console.log(`Carga de stock de insumos de refinado (Excel 26-Oct, col. STOCK EN TAQUE CRUDO): ${FILAS.length} filas (${aplicar ? 'APLICANDO' : 'DRY-RUN, nada se escribe'}).`);

  const act = await pool.query('SELECT id, nombre, um, stock, estado FROM stock_insumos_refinado ORDER BY id ASC');
  const porExacto = new Map();
  const porNorm = new Map();
  for (const r of act.rows) {
    porExacto.set(String(r.nombre).trim(), r);
    if (!porNorm.has(norm(r.nombre))) porNorm.set(norm(r.nombre), r);
  }

  const plan = [];
  const faltantes = [];
  const vistos = new Set();
  for (const [nombre, cantidad, um] of FILAS) {
    const exacto = porExacto.get(String(nombre).trim());
    const aprox = exacto || porNorm.get(norm(nombre));
    if (!aprox) {
      faltantes.push({ nombre, cantidad, um });
      continue;
    }
    if (vistos.has(aprox.id)) {
      console.log(`AVISO: "${nombre}" cae al mismo insumo que otro ya planificado (id ${aprox.id}): solo se aplicará la última fila. Revísalo.`);
    }
    vistos.add(aprox.id);
    const anterior = Number(aprox.stock) || 0;
    const dif = Math.round(((Number(cantidad) - anterior) + Number.EPSILON) * 100) / 100;
    plan.push({
      id: aprox.id,
      nombre: aprox.nombre,
      como: exacto ? 'exacto' : `parecido (Excel: "${nombre}")`,
      anterior,
      nuevo: Number(cantidad),
      um,
      umAntes: aprox.um,
      estadoAntes: aprox.estado,
      estado: estadoDe(cantidad),
      dif
    });
  }

  let sinCambios = 0;
  for (const p of plan) {
    const marca = p.dif === 0 ? '=' : (p.dif > 0 ? '+' : '');
    const umMk = (p.umAntes || '') === p.um ? '' : ` | UM ${p.umAntes} -> ${p.um}`;
    if (p.dif === 0 && !umMk) sinCambios += 1;
    console.log(`${p.dif === 0 && !umMk ? 'IGUAL ' : 'AJUSTE'} [${p.id}] ${p.nombre} | ${p.anterior} -> ${p.nuevo} (${marca}${p.dif})${umMk} | ${p.como}`);
  }
  console.log(`\nEncontrados: ${plan.length} (${sinCambios} sin cambios), no encontrados: ${faltantes.length}.`);
  if (faltantes.length) {
    console.log('NO ENCONTRADOS (se INSERTAN solo con --crear-faltantes):');
    for (const f of faltantes) console.log(`  - "${f.nombre}" | ${f.cantidad} ${f.um}`);
  }
  console.log('Nota: el estado se deriva de la regla de la app (stock <= 0 -> REALIZAR PEDIDO);');
  console.log('      la columna OBS del Excel (pedido por días de cobertura) no se copia.');

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
      const sinCambio = p.dif === 0 && (p.umAntes || '') === p.um;
      if (sinCambio) continue;
      await client.query(
        `UPDATE stock_insumos_refinado
         SET stock = $1::numeric,
             um = $2,
             estado = CASE WHEN $1::numeric <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END,
             usuario_ajuste = $3,
             fecha_ajuste = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [p.nuevo, p.um, USUARIO, p.id]
      );
      if (p.dif !== 0) {
        await client.query(
          `INSERT INTO historial_inventario (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
           VALUES ('AJUSTE', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [ORIGEN_HIST, p.nombre, p.id, Math.abs(p.dif), p.dif > 0 ? 'SUMA' : 'RESTA',
            p.anterior, p.nuevo, USUARIO,
            `Carga stock insumos refinado Excel 26-Oct: ${p.anterior} -> ${p.nuevo} (${p.um})`]
        );
      }
      n += 1;
    }

    let creados = 0;
    if (crearFaltantes) {
      for (const f of faltantes) {
        const ins = await client.query(
          'INSERT INTO stock_insumos_refinado (nombre, um, stock, estado, usuario_ajuste, fecha_ajuste) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING id',
          [f.nombre, f.um, f.cantidad, estadoDe(f.cantidad), USUARIO]
        );
        if (Number(f.cantidad) > 0) {
          await client.query(
            `INSERT INTO historial_inventario (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
             VALUES ('AJUSTE', $1, $2, $3, $4, 'SUMA', 0, $4, $5, $6)`,
            [ORIGEN_HIST, f.nombre, ins.rows[0].id, f.cantidad, USUARIO,
              `Alta por carga Excel 26-Oct (stock insumos refinado, ${f.um})`]
          );
        }
        creados += 1;
        console.log(`CREADO [${ins.rows[0].id}] ${f.nombre} | ${f.cantidad} ${f.um} | ${estadoDe(f.cantidad)}`);
      }
    }
    await client.query('COMMIT');
    console.log(`\nListo: ${n} insumos de refinado actualizados, ${creados} creados.`);
    console.log(`Revisa Almacén > 🛢️ Refinado y Auditoría > Historial (origen ${ORIGEN_HIST}).`);
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
