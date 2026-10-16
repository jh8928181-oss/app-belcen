require('dotenv').config({ path: '.env' });
require('dotenv').config({ path: '.env.local' });
const pool = require('../db');

// El artículo EN BLANCO de soplado ahora es genérico por tamaño (la marca la
// pone la etiqueta al etiquetar). Este script unifica los dos blancos que
// existían con el nombre de la marca hacia los genéricos nuevos. Idempotente.
const PARES = [
  { origenId: 88, destinoNombre: 'Botella 800 ml (blanco)' },
  { origenId: 89, destinoNombre: 'Botella 1 Lt (blanco)' }
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
    for (const { origenId, destinoNombre } of PARES) {
      const origen = (await client.query(
        'SELECT id, nombre, stock FROM inventario WHERE id = $1', [origenId]
      )).rows[0];
      if (!origen) {
        console.log(`SKIP: artículo ${origenId} ya no existe (¿ya unificado?).`);
        continue;
      }
      let destino = (await client.query(
        'SELECT id, nombre, stock FROM inventario WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1))',
        [destinoNombre]
      )).rows[0];

      await client.query('BEGIN');
      const mover = Number(origen.stock) || 0;
      if (!destino) {
        const creado = (await client.query(
          `INSERT INTO inventario (nombre, categoria, stock, unidad_medida, estado)
           VALUES ($1, 'BOTELLAS EN BLANCO', 0, 'UNIDADES', 'REALIZAR PEDIDO')
           RETURNING id, nombre, stock`,
          [destinoNombre]
        )).rows[0];
        destino = creado;
      }
      if (mover > 0) {
        await client.query(
          `UPDATE inventario
              SET stock = stock + $1,
                  estado = CASE WHEN stock + $1 <= 0 THEN 'REALIZAR PEDIDO' ELSE 'STOCK SUFICIENTE' END
            WHERE id = $2`,
          [mover, destino.id]
        );
      }
      for (const tabla of TABLAS_CON_ARTICULO) {
        await client.query(
          `UPDATE ${tabla} SET articulo_id = $1 WHERE articulo_id = $2`,
          [destino.id, origenId]
        );
      }
      await client.query('DELETE FROM inventario WHERE id = $1', [origenId]);
      if (mover > 0) {
        await client.query(
          `INSERT INTO historial_inventario
             (tipo, origen, producto, articulo_id, cantidad, tipo_cambio, stock_anterior, stock_nuevo, usuario, referencia)
           VALUES ('AJUSTE', 'unificacion', $1, $2, $3, 'SUMA', $4, $5, 'admin1', $6)`,
          [
            destino.nombre, destino.id, mover,
            Number(destino.stock) || 0, (Number(destino.stock) || 0) + mover,
            `Unificación de "${origen.nombre}" (artículo ${origenId}) al blanco genérico por tamaño`
          ]
        );
      }
      await client.query('COMMIT');
      console.log(`OK: "${origen.nombre}" (id ${origenId}, ${mover}) → "${destino.nombre}" (id ${destino.id})`);
    }

    const fin = await client.query(
      `SELECT id, nombre, categoria, stock, unidad_medida, estado
         FROM inventario WHERE categoria = 'BOTELLAS EN BLANCO' ORDER BY id`
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
