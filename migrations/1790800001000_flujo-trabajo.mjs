/**
 * Mapa de flujo de trabajo: nodos, conexiones y versiones guardadas.
 *
 * El grafo vive en base de datos (y no en localStorage) para que sobreviva al
 * cambio de navegador y se pueda versionar. La geometria x/y se guarda como
 * numeric para que el zoom del cliente no dependa de la escala del SVG.
 *
 * - flujo_conexiones tiene FK con ON DELETE CASCADE: borrar un nodo borra sus
 *   lineas, para que nunca queden ramas colgando a un id inexistente.
 * - El par (origen_id, destino_id) es unico, asi que arrastrar dos veces la
 *   misma conexion no la duplica.
 * - La semilla usa ON CONFLICT DO NOTHING y resuelve las conexiones por clave
 *   en vez de por id, porque los id los asigna la secuencia y varian entre
 *   bases. Asi la migracion es re-ejecutable sin duplicar el flujo inicial.
 */

export const up = (pgm) => {
  pgm.createTable('flujo_nodos', {
    id: { type: 'serial', primaryKey: true },
    clave: { type: 'varchar(50)', notNull: true },
    nombre: { type: 'varchar(120)', notNull: true },
    area: { type: 'varchar(50)', notNull: true, default: 'General' },
    descripcion: { type: 'text' },
    x: { type: 'numeric(10,2)', notNull: true, default: 0 },
    y: { type: 'numeric(10,2)', notNull: true, default: 0 },
    color: { type: 'varchar(20)', notNull: true, default: '#38bdf8' },
    metrica: { type: 'varchar(60)' },
    fecha_actualizacion: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('flujo_nodos', ['clave'], { unique: true, name: 'uq_flujo_nodos_clave' });
  pgm.createIndex('flujo_nodos', ['area']);

  pgm.createTable('flujo_conexiones', {
    id: { type: 'serial', primaryKey: true },
    origen_id: { type: 'int', notNull: true, references: 'flujo_nodos(id)', onDelete: 'CASCADE' },
    destino_id: { type: 'int', notNull: true, references: 'flujo_nodos(id)', onDelete: 'CASCADE' },
    etiqueta: { type: 'varchar(80)' },
    tipo: { type: 'varchar(20)', notNull: true, default: 'normal' },
    fecha_actualizacion: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('flujo_conexiones', ['origen_id', 'destino_id'], { unique: true, name: 'uq_flujo_conexion_par' });

  pgm.createTable('flujo_versiones', {
    id: { type: 'serial', primaryKey: true },
    nombre: { type: 'varchar(120)', notNull: true },
    snapshot: { type: 'jsonb', notNull: true },
    usuario: { type: 'varchar(50)' },
    fecha_creacion: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('flujo_versiones', ['fecha_creacion'], { descending: true, name: 'idx_flujo_versiones_fecha' });

  // ===== SEMILLA DEL FLUJO INICIAL =====
  // 15 etapas agrupadas por area. El orden de las columnas del SVG sale de los
  // valores x: Compras -> Recepcion -> Almacen -> Produccion, y Soporte debajo.
  pgm.sql(`
    INSERT INTO flujo_nodos (clave, nombre, area, descripcion, x, y, color, metrica) VALUES
      ('oc_os',                 'OC / OS',                    'Compras',   'Orden de compra o de servicio. Al emitirla, la cantidad se suma al stock del proveedor.', 60,  220, '#fbbf24', 'oc_activas'),
      ('vigilancia',            'Vigilancia',                 'Recepción', 'Registra el ingreso de la guía y el transportista. Queda pendiente de conformidad.',             320,  120, '#fbbf24', 'pendientes_vigilancia'),
      ('almacen_conformidad',   'Almacén - Conformidad',      'Recepción', 'Revisa cantidades físicas contra la guía. Confirma o devuelve el ingreso.',                   320,  240, '#22d3ee', 'pendientes_vigilancia'),
      ('registro_ingresos',     'Registro de ingresos',       'Recepción', 'Ingreso conforme: suma al inventario y deja rastro en el historial de movimientos.',             320,  360, '#22d3ee', 'ingresos_almacen'),
      ('stock_proveedores',     'Stock de proveedores',       'Almacén',   'Existencias agregadas por proveedor. Se mueven al emitir o recibir una orden.',                 600,  120, '#22d3ee', 'stock_proveedores_items'),
      ('stock_inventario',      'Stock de inventario',        'Almacén',   'Nodo central del flujo: todo lo que entra o sale de la planta pasa por aquí.',                600,  260, '#4ade80', 'inventario_items'),
      ('salidas_almacen',       'Salidas de almacén',         'Almacén',   'Despachos con guía. Restan del inventario y quedan pendientes de regularizar.',                 600,  400, '#22d3ee', 'salidas'),
      ('soplado',               'Soplado',                    'Producción','Producción de botellas y preformas con etiqueta automática.',                                  900,   40, '#4ade80', 'soplado_reportes'),
      ('envasado',              'Envasado',                   'Producción','Línea de llenado de aceite de soya. Reporta cajas y toneladas por turno.',                      900,  160, '#a78bfa', 'produccion_reportes'),
      ('refinado',              'Refinado',                   'Producción','Proceso de aceite de soya, con control de insumos y merma.',                                    900,  280, '#2dd4bf', 'refinado_reportes'),
      ('produccion',            'Producción',                 'Producción','Consolida el consumo real de insumos y descuenta el stock del inventario.',                    1180, 200, '#a78bfa', 'produccion_reportes'),
      ('producto_terminado',    'Producto terminado',         'Producción','Stock en cajas por presentación. Es la salida de la línea hacia el mercado.',                  1460, 200, '#4ade80', 'producto_terminado_items'),
      ('recetas',               'Recetas / BOM',              'Soporte',   'Define insumos, merma y stock de seguridad por producto. Gobierna lo que descuenta producción.',  900,  460, '#cbd5e1', 'receta_vigentes'),
      ('auditoria',             'Auditoría',                  'Soporte',   'Revisa movimientos, accesos y cierres sin escribir en el inventario.',                          600,  540, '#cbd5e1', 'movimientos_inventario'),
      ('basededatos_planta',    'Base de datos de planta',    'Soporte',   'Simulador de insumos: proyecta el consumo de una receta contra el stock real.',                   320,  560, '#2dd4bf', 'inventario_bajo_stock')
    ON CONFLICT (clave) DO NOTHING
  `);

  // 20 conexiones. La secuencia principal va OC/OS -> Vigilancia -> Almacén ->
  // Registro de ingresos -> Stock, y desde el stock se reparte a producción,
  // salidas y auditoría.
  pgm.sql(`
    INSERT INTO flujo_conexiones (origen_id, destino_id, etiqueta, tipo)
    SELECT o.id, d.id, v.etiqueta, v.tipo
    FROM (VALUES
      ('oc_os',              'vigilancia',          'Ingreso con guía',  'normal'),
      ('vigilancia',         'almacen_conformidad', 'Pide conformidad',  'normal'),
      ('almacen_conformidad','registro_ingresos',   'Conforme',          'normal'),
      ('registro_ingresos',  'stock_inventario',    'Suma stock',        'normal'),
      ('oc_os',              'stock_proveedores',   'Al recibir',        'normal'),
      ('stock_inventario',   'salidas_almacen',     'Despacha',          'normal'),
      ('stock_inventario',   'soplado',             'Insumos',           'normal'),
      ('stock_inventario',   'envasado',            'Insumos',           'normal'),
      ('stock_inventario',   'refinado',            'Insumos',           'normal'),
      ('stock_inventario',   'auditoria',           'Movimientos',       'normal'),
      ('recetas',            'soplado',             'BOM',               'normal'),
      ('recetas',            'envasado',            'BOM',               'normal'),
      ('recetas',            'refinado',            'BOM',               'normal'),
      ('soplado',            'envasado',            'Botellas',          'normal'),
      ('envasado',           'produccion',          'Consumo real',      'normal'),
      ('refinado',           'produccion',          'Aceite de soya',    'normal'),
      ('produccion',         'producto_terminado',  'Cajas',             'normal'),
      ('producto_terminado', 'salidas_almacen',     'Despacho',          'normal'),
      ('recetas',            'basededatos_planta',  'Simula',            'normal'),
      ('stock_inventario',   'basededatos_planta',  'Stock real',        'normal')
    ) AS v(origen, destino, etiqueta, tipo)
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
  pgm.dropTable('flujo_versiones');
  pgm.dropTable('flujo_conexiones');
  pgm.dropTable('flujo_nodos');
};
