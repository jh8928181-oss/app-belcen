/**
 * Detalle de nodos y conexiones del mapa de flujo.
 *
 * La primera version del mapa se quedaba corta en dos cosas. Los nodos solo
 * tenian nombre, area, descripcion y una metrica en vivo, asi que no se sabia
 * quien responde por la etapa ni cuanto deberia tardar. Y las conexiones solo
 * tenian una etiqueta corta: el tipo (normal, decision, rechazo) vivia
 * unicamente en el color de la linea, y en la practica las 20 conexiones
 * iniciales eran todas 'normal', asi que el tipo no distinguia nada.
 *
 * - Las columnas son todas nullable a proposito: las 15 filas y 20 conexiones
 *   que ya existen se quedan tal cual, con los campos nuevos vacios.
 * - El re-espaciado vertical acompana a la tarjeta mas alta del cliente. Las
 *   posiciones actuales son las de la semilla de 1790800001000 (el mapa nunca se
 *   reacomodo a mano), asi que recalcular y no muerde posiciones ajenas. Solo
 *   cambia y: la columna x de cada area se respeta y el recorrido se mantiene.
 * - Las 6 conexiones que se agregan cierran las ramas que el propio mapa
 *   describia pero no dibujaba: almacen_conformidad decia "confirma o devuelve
 *   el ingreso" y no habia ninguna conexion de devolucion, igual con las mermas.
 *   Van por clave y con ON CONFLICT DO NOTHING, como la semilla original.
 *
 * Los valores van en crudo y no como parametros porque pgm.sql de
 * node-pg-migrate no los acepta. Es seguro aqui: son literales de este archivo,
 * no entrada de usuario.
 */

const COLUMNAS_NODO = {
  oc_os: ['Compras', '1 día hábil', 'basededatosgeneral.html · Órdenes OC/OS'],
  vigilancia: ['Vigilancia', 'Inmediato', 'vigilancia.html'],
  almacen_conformidad: ['Almacén', '4 h', 'almacen.html · Conformidad'],
  registro_ingresos: ['Almacén', '2 h', 'almacen.html · Registro de ingresos'],
  stock_proveedores: ['Almacén', '1 turno', 'basededatosgeneral.html · Stock de proveedores'],
  stock_inventario: ['Almacén', 'Permanente', 'almacen.html · Inventario'],
  salidas_almacen: ['Almacén / Logística', '4 h', 'almacen.html · Salidas'],
  soplado: ['Producción - Soplado', 'Por turno', 'soplado.html'],
  envasado: ['Producción - Envasado', 'Por turno', 'envasado.html'],
  refinado: ['Producción - Refinado', 'Por turno', 'refinado.html'],
  produccion: ['Producción', 'Por turno', 'envasado.html · Reporte de producción'],
  producto_terminado: ['Producción / Almacén', '1 turno', 'almacen.html · Producto terminado'],
  recetas: ['Ing. de Producción', '2 días', 'recetas.html'],
  auditoria: ['Auditoría', 'Diario', 'auditoria.html'],
  basededatos_planta: ['Ing. de Producción', '1 h', 'basededatosdeplanta.html']
};

/**
 * Re-espaciado completo. La tarjeta del cliente pasa de 216x92 a 248x118 para
 * que quepan las dos lineas de descripcion y el chip de metrica, y eso obliga a
 * mover las dos coordenadas:
 *
 * - y: el ritmo vertical era de 120 px y con una tarjeta de 118 los nodos de una
 *   misma columna se tocaban. Ahora es de 162 (118 + 44 de aire).
 * - x: las columnas estaban cada 300 px y una tarjeta de 248 dejaba 52 px entre
 *   columnas, con los recuadros de area encima uno de otro. Ahora es 336.
 *
 * Las posiciones actuales son las de la semilla de 1790800001000: el mapa nunca
 * se reacomodo a mano, asi que recalcular no pisa nada.
 */
const POSICIONES = {
  oc_os: { x: 60, y: 190 },
  vigilancia: { x: 396, y: 60 },
  almacen_conformidad: { x: 396, y: 222 },
  registro_ingresos: { x: 396, y: 384 },
  basededatos_planta: { x: 396, y: 546 },
  stock_proveedores: { x: 732, y: 60 },
  stock_inventario: { x: 732, y: 222 },
  salidas_almacen: { x: 732, y: 384 },
  auditoria: { x: 732, y: 546 },
  soplado: { x: 1068, y: 30 },
  envasado: { x: 1068, y: 192 },
  refinado: { x: 1068, y: 354 },
  recetas: { x: 1068, y: 516 },
  produccion: { x: 1404, y: 222 },
  producto_terminado: { x: 1740, y: 222 }
};

function entreComillas(valor) {
  if (valor === null || valor === undefined) return 'NULL';
  return `'${String(valor).replace(/'/g, "''")}'`;
}

export const up = (pgm) => {
  // ---------- COLUMNAS NUEVAS ----------

  pgm.addColumns('flujo_nodos', {
    responsable: { type: 'varchar(80)' },
    tiempo_estimado: { type: 'varchar(40)' },
    sistema: { type: 'varchar(80)' },
    notas: { type: 'text' }
  });

  pgm.addColumns('flujo_conexiones', {
    evento: { type: 'varchar(140)' },
    condicion: { type: 'varchar(140)' },
    sla: { type: 'varchar(40)' },
    responsable: { type: 'varchar(80)' }
  });

  // ---------- RESPONSABLE / TIEMPO / SISTEMA DE LOS NODOS ----------
  // Propuestas a partir del area y del modulo que ya describia cada nodo. Todos
  // son editables desde el panel del mapa.

  pgm.sql(`
    UPDATE flujo_nodos n SET
      responsable = v.responsable,
      tiempo_estimado = v.tiempo,
      sistema = v.sistema
    FROM (VALUES
      ${Object.entries(COLUMNAS_NODO)
        .map(([clave, [responsable, tiempo, sistema]]) =>
          `(${entreComillas(clave)}, ${entreComillas(responsable)}, ${entreComillas(tiempo)}, ${entreComillas(sistema)})`)
        .join(',\n      ')}
    ) AS v(clave, responsable, tiempo, sistema)
    WHERE n.clave = v.clave
  `);

  // ---------- RE-ESPACIADO ----------

  for (const [clave, pos] of Object.entries(POSICIONES)) {
    pgm.sql(
      `UPDATE flujo_nodos SET x = ${Number(pos.x)}, y = ${Number(pos.y)} WHERE clave = ${entreComillas(clave)}`
    );
  }

  // ---------- LAS 6 CONEXIONES QUE FALTABAN ----------
  // Cierran la rama de rechazo (devolucion, observados, mermas) y el punto de
  // decision que el mapa describia pero no dibujaba.

  pgm.sql(`
    INSERT INTO flujo_conexiones (origen_id, destino_id, etiqueta, tipo, evento, condicion, sla, responsable)
    SELECT o.id, d.id, v.etiqueta, v.tipo, v.evento, v.condicion, v.sla, v.responsable
    FROM (VALUES
      ('almacen_conformidad', 'oc_os',              'Devolución al proveedor', 'rechazo',  'Ingreso no conforme',          'Cantidades o calidad no coinciden con la guía',      '4 h',      'Almacén / Compras'),
      ('almacen_conformidad', 'auditoria',          'Observado: deja rastro', 'rechazo',  'Diferencia detectada en recepción', 'Se registra la observación con evidencia',          '8 h',      'Almacén / Auditoría'),
      ('soplado',            'stock_inventario',   'Merma y descartes',       'rechazo',  'Producción con merma',          'Piezas fuera de especificación',                       '1 turno',  'Producción - Soplado'),
      ('envasado',           'stock_inventario',   'Merma de llenado',        'rechazo',  'Llenado con merma',             'Cajas incompletas o derrames',                          '1 turno',  'Producción - Envasado'),
      ('refinado',           'stock_inventario',   'Merma de refinado',       'rechazo',  'Proceso con merma',             'Insumos perdidos o fuera de norma',                    '1 turno',  'Producción - Refinado'),
      ('produccion',         'basededatos_planta', 'Proyecta plan',           'decision', 'Plan de producción del turno',  'Se requiere proyección de insumos',                    '1 h',      'Ing. de Producción')
    ) AS v(origen, destino, etiqueta, tipo, evento, condicion, sla, responsable)
    JOIN flujo_nodos o ON o.clave = v.origen
    JOIN flujo_nodos d ON d.clave = v.destino
    ON CONFLICT (origen_id, destino_id) DO NOTHING
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  // Solo se van las 6 conexiones agregadas por clave: el resto del grafo lo
  // administra el mapa desde la pantalla, no esta migracion.
  pgm.sql(`
    DELETE FROM flujo_conexiones c
    USING flujo_nodos o, flujo_nodos d
    WHERE c.origen_id = o.id AND c.destino_id = d.id
      AND (o.clave, d.clave) IN (
        ('almacen_conformidad', 'oc_os'),
        ('almacen_conformidad', 'auditoria'),
        ('soplado', 'stock_inventario'),
        ('envasado', 'stock_inventario'),
        ('refinado', 'stock_inventario'),
        ('produccion', 'basededatos_planta')
      )
  `);

  pgm.sql(`
    UPDATE flujo_nodos n SET x = v.x, y = v.y FROM (VALUES
      ('oc_os', 60, 220), ('vigilancia', 320, 120), ('almacen_conformidad', 320, 240),
      ('registro_ingresos', 320, 360), ('stock_proveedores', 600, 120), ('stock_inventario', 600, 260),
      ('salidas_almacen', 600, 400), ('soplado', 900, 40), ('envasado', 900, 160), ('refinado', 900, 280),
      ('produccion', 1180, 200), ('producto_terminado', 1460, 200), ('recetas', 900, 460),
      ('auditoria', 600, 540), ('basededatos_planta', 320, 560)
    ) AS v(clave, x, y)
    WHERE n.clave = v.clave
  `);

  pgm.sql('UPDATE flujo_nodos SET responsable = NULL, tiempo_estimado = NULL, sistema = NULL, notas = NULL');

  pgm.dropColumns('flujo_conexiones', ['evento', 'condicion', 'sla', 'responsable']);
  pgm.dropColumns('flujo_nodos', ['responsable', 'tiempo_estimado', 'sistema', 'notas']);
};
