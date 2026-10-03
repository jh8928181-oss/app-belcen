/**
 * Datos para imprimir la orden de compra en PDF.
 *
 * El formato de la OC pide once cosas que el formulario de orden no pedia y que
 * en la base no existian: donde se entrega, cuando, que area lo pidio, como se
 * paga, en que horario se recibe, a quien se atiende, las cuentas bancarias del
 * proveedor, y quien la emitio con nombre y cargo. Sin esto el PDF sale con
 * huecos que el proveedor necesita para poder cumplir.
 *
 * De las columnas todas, una merece nombre propio:
 *
 *   usuario_emision es inmutable y usuario_registro no lo es.
 *
 * usuario_registro se reescribe en cada UPDATE de la orden (index.js, ruta PUT),
 * asi que la usa "quien toco la orden ultimo". Para un documento que sale
 * firmado hacia afuera eso no sirve: si alguien edita la OC de otro, el PDF
 * terminaria-emittingela por el editor. usuario_emision se escribe una sola vez,
 * al crear, y ninguna ruta posterior lo vuelve a tocar.
 *
 * hora_emision no necesita columna: fecha_registro ya es el timestamp del INSERT
 * y, a diferencia de usuario_registro, el UPDATE no lo pisa.
 *
 * Todas las columnas son nullable a proposito: las ordenes ya emitidas no
 * tienen estos datos y no se van a inventar. Salen en blanco hasta que alguien
 * los llene.
 */

export const up = (pgm) => {
  pgm.addColumns('ordenes_compras_servicios', {
    lugar_entrega: { type: 'varchar(200)' },
    fecha_entrega: { type: 'date' },
    area_solicitante: { type: 'varchar(100)' },
    forma_pago: { type: 'varchar(100)' },
    horario_recepcion: { type: 'varchar(100)' },
    atencion: { type: 'varchar(150)' },
    usuario_emision: { type: 'varchar(50)' }
  });

  // Cuentas bancarias del proveedor. Es una tabla y no una columna de texto
  // porque una OC puede ir con varias cuentas y porque el dato es del
  // proveedor, no de la orden: se llena una vez y lo usan todas sus ordenes.
  pgm.createTable('proveedor_cuentas_bancarias', {
    id: { type: 'serial', primaryKey: true },
    proveedor_id: {
      type: 'int',
      notNull: true,
      references: 'proveedores(id)',
      onDelete: 'CASCADE'
    },
    banco: { type: 'varchar(100)', notNull: true },
    tipo: { type: 'varchar(50)' },
    numero: { type: 'varchar(50)', notNull: true },
    moneda: { type: 'varchar(3)', notNull: true, default: 'PEN' },
    titular: { type: 'varchar(150)' },
    orden: { type: 'smallint', notNull: true, default: 0 },
    usuario_registro: { type: 'varchar(50)' },
    fecha_registro: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') }
  });

  pgm.createIndex('proveedor_cuentas_bancarias', 'proveedor_id',
    { name: 'idx_proveedor_cuentas_bancarias_proveedor' });

  // La OC lleva "EMITIDO POR / CARGO / CEL" en el encabezado. usuario_sistema
  // solo guardaba el login y el rol de acceso, que no es un cargo: admin1 es un
  // nombre de cuenta, no el puesto de la persona que firmo.
  pgm.addColumns('usuarios_sistema', {
    nombre: { type: 'varchar(100)' },
    cargo: { type: 'varchar(100)' },
    celular: { type: 'varchar(50)' }
  });
};

export const down = (pgm) => {
  pgm.dropColumns('usuarios_sistema', ['nombre', 'cargo', 'celular']);
  pgm.dropTable('proveedor_cuentas_bancarias');
  pgm.dropColumns('ordenes_compras_servicios', [
    'lugar_entrega', 'fecha_entrega', 'area_solicitante',
    'forma_pago', 'horario_recepcion', 'atencion', 'usuario_emision'
  ]);
};