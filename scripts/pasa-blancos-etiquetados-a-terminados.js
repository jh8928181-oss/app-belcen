require('dotenv').config({ path: '.env' });
require('dotenv').config({ path: '.env.local' });
const pool = require('../db');

// El usuario reportó que las botellas que estaban en "(blanco)" (9019 Don
// Lalo de 800 ml y 480 Belini de 1 Lt) ya estaban ETIQUETADAS: pertenecen a
// su artículo terminado, no al blanco. Este script pasa ese stock al
// artículo terminado y borra el blanco (soplado lo vuelve a crear vacío en
// la próxima producción). Idempotente.
const PARES = [
  { origenNombre: 'Botella 800 ml (blanco)', destinoId: 7 },
  { origenNombre: 'Botella 1 Lt (blanco)', destinoId: 12 }
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
    for (const { origenNombre, destinoId } of PARES) {
      const origen = (await client.query(
        'SELECT id, nombre, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1))',
        [origenNombre]
      )).rows[0];
      const destino = (await client.query(
        'SELECT id, nombre, stock FROM inventario WHERE id = $1', [destinoId]
      )).rows[0];
      if (!origen || !destino) {
        console.log(`SKIP: falta "${origenNombre}" o el artículo ${destinoId} (¿ya movido?).`);
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
          [destinoId, origen.id]
        );
      }
      await client.query('DELETE FROM inventario WHERE id = $1', [origen.id]);
      if (mover > 0) {
        await client.query(
          `INSERT INTO historial_inventario
             (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
           VALUES ('AJUSTE', 'reclasificacion', $1, $2, $3, 'SUMA', $4, $5, 'admin1', $6)`,
          [
            destino.nombre, destinoId, mover,
            Number(destino.stock) || 0, (Number(destino.stock) || 0) + mover,
            `Botellas ya etiquetadas pasadas de "${origen.nombre}" a su artículo terminado (reporte del usuario)`
          ]
        );
      }
      await client.query('COMMIT');
      console.log(`OK: "${origen.nombre}" (id ${origen.id}, ${mover}) → "${destino.nombre}" (id ${destinoId})`);
    }

    const fin = await client.query(
      `SELECT id, nombre, categoria, stock, estado FROM inventario
        WHERE id IN (7, 12) OR categoria = 'BOTELLAS EN BLANCO' ORDER BY id`
    );
    fin.rows.forEach(r => console.log('FINAL: ' + JSON.stringify(r)));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
