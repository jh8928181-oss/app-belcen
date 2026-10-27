const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });

/**
 * Backfill del circuito de servicios externos tras el cambio de regla
 * "primero se consume el saldo enviado; del inventario solo baja el
 * excedente que nunca se envió".
 *
 * A) CONTROL N-014052 (B&M, 20.160 botellas Don Lalo, 26-Oct): sus items no
 *    traían etiqueta/preforma, así que el panel no le descontaba nada al
 *    saldo enviado. Se completan con etq63 + pref50 a 20.16 MILLARES. El
 *    envío del 26-Oct (33.8 etq63 / 45 pref50) ya descontó esas insumos al
 *    salir, así que NO se mueve inventario (salvo excedente, si lo hubiera).
 *
 * B) GUIAs EG07-00002476 (612) y EG07-00002477 (6.579) de SAUÑE: descontaron
 *    7.191 MILLARES de etq59 y de pref50 del inventario, pero esas mismas
 *    insumos ya habían salido con el envío del 17-Oct (doble descuento).
 *    Se devuelve al inventario lo que el saldo enviado cubría (7.191 de
 *    cada uno; el tope es lo enviado).
 *
 * Idempotente: la parte B queda marcada en historial_inventario (origen
 * 'backfill_servicios_27oct') y la parte A se salta si los items ya traen
 * etiqueta.
 *
 * DRY-RUN por defecto; --aplicar escribe en transacción.
 *
 * Uso:
 *   node scripts/backfill-servicios-27oct.js             (ver plan)
 *   node scripts/backfill-servicios-27oct.js --aplicar   (aplicar)
 */
const pool = require('../db');

const ORIGEN_HIST = 'backfill_servicios_27oct';
const USUARIO = 'backfill_servicios';

const round6 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 1000000) / 1000000;

function estadoDe(stock) {
  return Number(stock) <= 0 ? 'REALIZAR PEDIDO' : 'STOCK SUFICIENTE';
}

async function main() {
  const aplicar = process.argv.slice(2).includes('--aplicar');
  console.log(`Backfill servicios externos: ${aplicar ? 'APLICANDO' : 'DRY-RUN, nada se escribe'}.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---------- A) CONTROL N-014052: completar items con etq63 + pref50 ----
    const ctl = await client.query(
      `SELECT g.id, g.servicio, g.tipo_doc, g.numero, g.cantidad
         FROM servicios_guias g
        WHERE g.tipo_doc = 'CONTROL' AND g.numero = 'N-014052' AND g.servicio = 'B&M DYLPLAST'`
    );
    if (!ctl.rows.length) {
      console.log('A) CONTROL N-014052: no existe, se omite.');
    } else {
      const ctlId = ctl.rows[0].id;
      const items = await client.query(
        `SELECT id, producto, cantidad, etiqueta_id, cant_etiquetas, preforma_id, cant_preformas
           FROM servicios_guias_items WHERE guia_id = $1 ORDER BY id`, [ctlId]
      );
      const yaListo = items.rows.length > 0 && items.rows.every(
        it => it.etiqueta_id && it.preforma_id && it.cant_etiquetas != null && it.cant_preformas != null
      );
      if (yaListo) {
        console.log(`A) CONTROL N-014052 (id ${ctlId}): items ya completos, sin cambios.`);
      } else if (!items.rows.length) {
        console.log(`A) CONTROL N-014052 (id ${ctlId}): sin filas de items; se omite (revisar a mano).`);
      } else {
        const consumo = round6(items.rows.reduce((s, r) => s + (Number(r.cantidad) || 0), 0) / 1000);
        // Cobertura del envío B&M por artículo.
        const env = await client.query(
          `SELECT articulo_id, COALESCE(SUM(cantidad), 0) AS enviado
             FROM servicios_envios
            WHERE servicio = 'B&M DYLPLAST' AND articulo_id IN (63, 50)
            GROUP BY articulo_id`
        );
        const enviadoPor = {};
        for (const e of env.rows) enviadoPor[e.articulo_id] = Number(e.enviado) || 0;
        const etq = await client.query('SELECT id, nombre, stock FROM inventario WHERE id = 63');
        const pref = await client.query('SELECT id, nombre, stock FROM inventario WHERE id = 50');
        if (!etq.rows.length || !pref.rows.length) {
          throw new Error('Faltan los artículos 63 (etq Don Lalo 800) o 50 (preforma 23.5) en inventario.');
        }
        console.log(`A) CONTROL N-014052 (id ${ctlId}): consumo ${consumo} MILLARES (20.160 botellas).`);
        console.log(`   Envío B&M: etq63 enviado ${enviadoPor[63] ?? 0} | pref50 enviado ${enviadoPor[50] ?? 0}.`);
        for (const [artId, row] of [[63, etq.rows[0]], [50, pref.rows[0]]]) {
          const cubierto = Math.min(consumo, enviadoPor[artId] || 0);
          const excedente = round6(consumo - cubierto);
          console.log(`   art ${artId} ${row.nombre}: cubierto por envío ${cubierto}, excedente a inventario ${excedente} (stock actual ${Number(row.stock)}).`);
          if (excedente > 0 && (Number(row.stock) || 0) < excedente) {
            throw new Error(`Stock insuficiente para el excedente de ${excedente} MILLARES de "${row.nombre}".`);
          }
        }
        // Completar los items (el nombre del artículo se toma del inventario).
        for (const it of items.rows) {
          await client.query(
            `UPDATE servicios_guias_items
                SET etiqueta_id = 63, etiqueta_nombre = $1, cant_etiquetas = $2,
                    preforma_id = 50, preforma_nombre = $3, cant_preformas = $4
              WHERE id = $5`,
            [etq.rows[0].nombre, consumo, pref.rows[0].nombre, consumo, it.id]
          );
        }
        // Solo se descuenta inventario si el envío no alcanzó a cubrirlo.
        for (const [artId, row] of [[63, etq.rows[0]], [50, pref.rows[0]]]) {
          const excedente = round6(consumo - Math.min(consumo, enviadoPor[artId] || 0));
          if (excedente > 0) {
            const ant = Number(row.stock) || 0;
            const nuevo = round6(ant - excedente);
            await client.query(
              'UPDATE inventario SET stock = $1::numeric, estado = $2 WHERE id = $3',
              [nuevo, estadoDe(nuevo), artId]
            );
            await client.query(
              `INSERT INTO historial_inventario (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
               VALUES ('SALIDA', $1, $2, $3, $4, 'RESTA', $5, $6, $7, $8)`,
              [ORIGEN_HIST, row.nombre, artId, excedente, ant, nuevo, USUARIO,
                `Backfill control N-014052: excedente no cubierto por el envío B&M (${excedente} MILLARES)`]
            );
          }
        }
        console.log(`A) listo: ${items.rows.length} item(s) del control N-014052 completados con ${consumo} MILLARES de etq63 + pref50.`);
      }
    }

    // ---------- B) SAUÑE: reversa del doble descuento de las guías 2-3 -----
    const marcado = await client.query(
      `SELECT 1 FROM historial_inventario WHERE origen = $1 LIMIT 1`, [ORIGEN_HIST]
    );
    if (marcado.rows.length) {
      console.log('B) SAUÑE: ya fue aplicado antes (marcado en historial), sin cambios.');
    } else {
      const env = await client.query(
        `SELECT articulo_id, COALESCE(SUM(cantidad), 0) AS enviado
           FROM servicios_envios
          WHERE servicio = 'SAUÑE' AND articulo_id IN (59, 50)
          GROUP BY articulo_id`
      );
      const enviadoPor = {};
      for (const e of env.rows) enviadoPor[e.articulo_id] = Number(e.enviado) || 0;
      const cons = await client.query(
        `SELECT i.etiqueta_id AS articulo_id, COALESCE(SUM(i.cant_etiquetas), 0) AS consumido
           FROM servicios_guias_items i
           JOIN servicios_guias g ON g.id = i.guia_id
          WHERE g.servicio = 'SAUÑE' AND g.tipo_doc = 'GUIA' AND i.etiqueta_id IS NOT NULL
          GROUP BY i.etiqueta_id
         UNION ALL
         SELECT i.preforma_id AS articulo_id, COALESCE(SUM(i.cant_preformas), 0) AS consumido
           FROM servicios_guias_items i
           JOIN servicios_guias g ON g.id = i.guia_id
          WHERE g.servicio = 'SAUÑE' AND g.tipo_doc = 'GUIA' AND i.preforma_id IS NOT NULL
          GROUP BY i.preforma_id`
      );
      const consumidoPor = {};
      for (const c of cons.rows) {
        if (!c.articulo_id) continue;
        consumidoPor[c.articulo_id] = (consumidoPor[c.articulo_id] || 0) + (Number(c.consumido) || 0);
      }
      console.log('B) SAUÑE guías: consumo registrado', consumidoPor, '| enviado', enviadoPor);

      for (const artId of [59, 50]) {
        const consumo = round6(consumidoPor[artId] || 0);
        const revertir = round6(Math.min(consumo, enviadoPor[artId] || 0));
        if (revertir <= 0) {
          console.log(`   art ${artId}: nada que revertir (consumo ${consumo}, enviado ${enviadoPor[artId] || 0}).`);
          continue;
        }
        const row = await client.query('SELECT id, nombre, stock FROM inventario WHERE id = $1', [artId]);
        if (!row.rows.length) throw new Error(`Falta el artículo ${artId} en inventario.`);
        const ant = Number(row.rows[0].stock) || 0;
        const nuevo = round6(ant + revertir);
        console.log(`   art ${artId} ${row.rows[0].nombre}: +${revertir} MILLARES (${ant} -> ${nuevo}); el resto del consumo sí era de inventario y se queda.`);
        if (aplicar) {
          await client.query(
            'UPDATE inventario SET stock = $1::numeric, estado = $2 WHERE id = $3',
            [nuevo, estadoDe(nuevo), artId]
          );
          await client.query(
            `INSERT INTO historial_inventario (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
             VALUES ('ENTRADA', $1, $2, $3, $4, 'SUMA', $5, $6, $7, $8)`,
            [ORIGEN_HIST, row.rows[0].nombre, artId, revertir, ant, nuevo, USUARIO,
              `Reversa doble descuento: guías SAUÑE EG07-00002476/77 descontaron ${consumo} MILLARES que ya salieron con el envío del 17-Oct`]
          );
        }
      }
      if (!aplicar) console.log('   (dry-run: la reversa de SAUÑE solo se escribe con --aplicar)');
    }

    if (aplicar) {
      await client.query('COMMIT');
      console.log('\nListo: backfill aplicado (commit).');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY-RUN: nada escrito (rollback). Relee el plan y corre con --aplicar.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error, nada se escribió:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
