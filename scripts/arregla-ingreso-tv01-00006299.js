require('dotenv').config({ path: '.env' });
require('dotenv').config({ path: '.env.local' });
const pool = require('../db');

// La guía TV01-00006299 (EUROPLAST SAC, ingreso 16-Oct) llegó con los nombres
// tal cual los decía el papel ("BALDE BELINI 18 LT", "Tapa balde belini 18lt")
// y el ingreso les creó artículos nuevos en "General", cuando ya existían los
// reales en el catálogo: "Balde Belini x 18 lt" (BOTELLAS Y GALONERAS) y
// "Tapa BALDE BELINI color amarillo" (TAPAS Y ACCESORIOS), ambos en 0.
// Este script unifica: pasa el stock al artículo verdadero, reapunta las
// referencias (historial, registro de almacén, pendientes y salidas) y borra
// el duplicado. Idempotente: si el duplicado ya no existe, lo salta.
const PARES = [
  { origenId: 90, destinoId: 16 },
  { origenId: 91, destinoId: 45 }
];

const TABLAS_CON_ARTICULO = [
  'historial_inventario',
  'registro_ingresos_almacen',
  'ajustes_pendientes',
  'salidas_almacen',
  'servicios_envios',
  'terceros_preingresos'
];

(async () => {
  const client = await pool.connect();
  try {
    for (const { origenId, destinoId } of PARES) {
      const origen = (await client.query(
        'SELECT id, nombre, stock FROM inventario WHERE id = $1', [origenId]
      )).rows[0];
      const destino = (await client.query(
        'SELECT id, nombre, stock, categoria FROM inventario WHERE id = $1', [destinoId]
      )).rows[0];
      if (!origen || !destino) {
        console.log(`SKIP: artículo ${origenId} o ${destinoId} ya no existe (¿ya unificado?).`);
        continue;
      }

      await client.query('BEGIN');
      const mover = Number(origen.stock) || 0;
      if (mover > 0) {
        await client.query(
          `UPDATE inventario
              SET stock = stock + $1,
                  estado = CASE WHEN stock + $1 <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END
            WHERE id = $2`,
          [mover, destinoId]
        );
      }
      for (const tabla of TABLAS_CON_ARTICULO) {
        await client.query(
          `UPDATE ${tabla} SET articulo_id = $1 WHERE articulo_id = $2`,
          [destinoId, origenId]
        );
      }
      await client.query('DELETE FROM inventario WHERE id = $1', [origenId]);
      if (mover > 0) {
        await client.query(
          `INSERT INTO historial_inventario
             (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
           VALUES ('AJUSTE', 'unificacion', $1, $2, $3, 'SUMA', $4, $5, 'admin1', $6)`,
          [
            destino.nombre, destinoId, mover,
            Number(destino.stock) || 0, (Number(destino.stock) || 0) + mover,
            `Unificación de "${origen.nombre}" (artículo ${origenId}) — guía TV01-00006299`
          ]
        );
      }
      await client.query('COMMIT');
      console.log(`OK: "${origen.nombre}" (id ${origenId}, ${mover}) → "${destino.nombre}" (id ${destinoId}, ${destino.categoria})`);
    }

    const fin = await client.query(
      `SELECT id, nombre, categoria, stock, unidad_medida, estado FROM inventario WHERE id IN (16, 45) ORDER BY id`
    );
    fin.rows.forEach(r => console.log('FINAL: ' + JSON.stringify(r)));
    const gen = await client.query(
      `SELECT COUNT(*)::int AS n FROM inventario WHERE LOWER(TRIM(categoria)) = 'general'`
    );
    console.log('Artículos que quedan en General: ' + gen.rows[0].n);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
