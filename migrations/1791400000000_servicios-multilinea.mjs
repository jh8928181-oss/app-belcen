// Una guia de servicio trae VARIOS productos y un envio lleva VARIOS insumos.
// La cabecera (servicios_guias) queda con totales y cada producto va en su
// linea (servicios_guias_items) con su etiqueta/preforma descontada y su
// botella sumada. La cabecera conserva sus columnas de item como resumen.

export const up = (pgm) => {
  pgm.createTable('servicios_guias_items', {
    id: { type: 'serial', primaryKey: true },
    guia_id: { type: 'int', notNull: true, references: 'servicios_guias(id)', onDelete: 'CASCADE' },
    producto: { type: 'varchar(150)', notNull: true },
    producto_key: { type: 'varchar(100)' },
    cantidad: { type: 'numeric(14,6)', notNull: true },
    etiqueta_id: { type: 'int', references: 'inventario(id)' },
    etiqueta_nombre: { type: 'varchar(150)' },
    cant_etiquetas: { type: 'numeric(14,6)' },
    preforma_id: { type: 'int', references: 'inventario(id)' },
    preforma_nombre: { type: 'varchar(150)' },
    cant_preformas: { type: 'numeric(14,6)' },
    botella_id: { type: 'int', references: 'inventario(id)' }
  });
  pgm.createIndex('servicios_guias_items', 'guia_id', { name: 'idx_servicios_items_guia' });
};

export const down = (pgm) => {
  pgm.dropTable('servicios_guias_items');
};
