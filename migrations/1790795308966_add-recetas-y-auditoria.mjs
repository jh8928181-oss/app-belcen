export const up = (pgm) => {
  pgm.createTable('recetas', {
    id: { type: 'serial', primaryKey: true },
    producto_key: { type: 'varchar(100)', notNull: true, references: 'producto_terminado(producto_key)' },
    version: { type: 'int', notNull: true, default: 1 },
    vigente_desde: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    vigente_hasta: { type: 'date' },
    activa: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'varchar(50)', notNull: true },
    observaciones: { type: 'text' },
    created_at: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.createIndex('recetas', ['producto_key', 'activa']);
  pgm.addConstraint('recetas', 'uk_receta_producto_version', 'UNIQUE(producto_key, version)');

  pgm.createTable('receta_insumos', {
    id: { type: 'serial', primaryKey: true },
    receta_id: { type: 'int', notNull: true, references: 'recetas(id)', onDelete: 'CASCADE' },
    insumo_nombre: { type: 'varchar(150)', notNull: true },
    cantidad_por_caja: { type: 'numeric(12,6)', notNull: true },
    unidad_medida: { type: 'varchar(20)', notNull: true },
    obligatorio: { type: 'boolean', notNull: true, default: true },
    orden: { type: 'int', notNull: true, default: 0 },
    notas: { type: 'text' },
  });
  pgm.createIndex('receta_insumos', 'receta_id');

  pgm.createTable('historial_accesos', {
    id: { type: 'bigserial', primaryKey: true },
    usuario: { type: 'varchar(50)', notNull: true },
    accion: { type: 'varchar(20)', notNull: true },
    ip: { type: 'inet' },
    user_agent: { type: 'text' },
    exito: { type: 'boolean', notNull: true },
    mensaje_error: { type: 'text' },
    fecha: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.createIndex('historial_accesos', ['usuario', 'fecha'], { descending: true });

  pgm.createTable('historial_usuarios', {
    id: { type: 'bigserial', primaryKey: true },
    usuario_afectado: { type: 'varchar(50)', notNull: true },
    accion: { type: 'varchar(20)', notNull: true },
    usuario_ejecutor: { type: 'varchar(50)', notNull: true },
    valores_anteriores: { type: 'jsonb' },
    valores_nuevos: { type: 'jsonb' },
    ip: { type: 'inet' },
    fecha: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.createIndex('historial_usuarios', ['usuario_afectado', 'fecha'], { descending: true });

  pgm.createTable('historial_recetas', {
    id: { type: 'bigserial', primaryKey: true },
    receta_id: { type: 'int', notNull: true, references: 'recetas(id)' },
    accion: { type: 'varchar(20)', notNull: true },
    usuario_ejecutor: { type: 'varchar(50)', notNull: true },
    valores_anteriores: { type: 'jsonb' },
    valores_nuevos: { type: 'jsonb' },
    fecha: { type: 'timestamp', default: pgm.func('CURRENT_TIMESTAMP') },
  });
  pgm.createIndex('historial_recetas', ['receta_id', 'fecha'], { descending: true });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION trg_historial_usuarios() RETURNS TRIGGER AS $$
    DECLARE v_usuario_ejecutor text := COALESCE(current_setting('app.current_user', true), 'system');
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO historial_usuarios (usuario_afectado, accion, usuario_ejecutor, valores_nuevos, ip)
        VALUES (NEW.usuario, 'CREATE', v_usuario_ejecutor, to_jsonb(NEW) - 'password', inet_client_addr());
      ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO historial_usuarios (usuario_afectado, accion, usuario_ejecutor, valores_anteriores, valores_nuevos, ip)
        VALUES (NEW.usuario, 'UPDATE', v_usuario_ejecutor, to_jsonb(OLD) - 'password', to_jsonb(NEW) - 'password', inet_client_addr());
      ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO historial_usuarios (usuario_afectado, accion, usuario_ejecutor, valores_anteriores, ip)
        VALUES (OLD.usuario, 'DELETE', v_usuario_ejecutor, to_jsonb(OLD) - 'password', inet_client_addr());
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`CREATE TRIGGER trg_historial_usuarios AFTER INSERT OR UPDATE OR DELETE ON usuarios_sistema FOR EACH ROW EXECUTE FUNCTION trg_historial_usuarios();`);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION trg_historial_recetas() RETURNS TRIGGER AS $$
    DECLARE v_usuario_ejecutor text := COALESCE(current_setting('app.current_user', true), 'system'); v_old jsonb; v_new jsonb;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        SELECT to_jsonb(r) || jsonb_build_object('insumos', (SELECT jsonb_agg(to_jsonb(ri)) FROM receta_insumos ri WHERE ri.receta_id = NEW.id)) INTO v_new FROM recetas r WHERE r.id = NEW.id;
        INSERT INTO historial_recetas (receta_id, accion, usuario_ejecutor, valores_nuevos) VALUES (NEW.id, 'CREATE', v_usuario_ejecutor, v_new);
      ELSIF TG_OP = 'UPDATE' THEN
        SELECT to_jsonb(r) || jsonb_build_object('insumos', (SELECT jsonb_agg(to_jsonb(ri)) FROM receta_insumos ri WHERE ri.receta_id = OLD.id)) INTO v_old FROM recetas r WHERE r.id = OLD.id;
        SELECT to_jsonb(r) || jsonb_build_object('insumos', (SELECT jsonb_agg(to_jsonb(ri)) FROM receta_insumos ri WHERE ri.receta_id = NEW.id)) INTO v_new FROM recetas r WHERE r.id = NEW.id;
        INSERT INTO historial_recetas (receta_id, accion, usuario_ejecutor, valores_anteriores, valores_nuevos) VALUES (OLD.id, 'UPDATE', v_usuario_ejecutor, v_old, v_new);
      ELSIF TG_OP = 'DELETE' THEN
        SELECT to_jsonb(r) || jsonb_build_object('insumos', (SELECT jsonb_agg(to_jsonb(ri)) FROM receta_insumos ri WHERE ri.receta_id = OLD.id)) INTO v_old FROM recetas r WHERE r.id = OLD.id;
        INSERT INTO historial_recetas (receta_id, accion, usuario_ejecutor, valores_anteriores) VALUES (OLD.id, 'DELETE', v_usuario_ejecutor, v_old);
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`CREATE TRIGGER trg_historial_recetas AFTER INSERT OR UPDATE OR DELETE ON recetas FOR EACH ROW EXECUTE FUNCTION trg_historial_recetas();`);

  pgm.sql(`ALTER TABLE inventario ADD CONSTRAINT chk_stock_no_negativo CHECK (stock >= 0);`);
  pgm.sql(`ALTER TABLE producto_terminado ADD CONSTRAINT chk_stock_cajas_no_negativo CHECK (stock_cajas >= 0);`);
  pgm.sql(`ALTER TABLE stock_insumos_refinado ADD CONSTRAINT chk_stock_refinado_no_negativo CHECK (stock >= 0);`);
};

export const down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_historial_recetas ON recetas;');
  pgm.sql('DROP FUNCTION IF EXISTS trg_historial_recetas();');
  pgm.sql('DROP TRIGGER IF EXISTS trg_historial_usuarios ON usuarios_sistema;');
  pgm.sql('DROP FUNCTION IF EXISTS trg_historial_usuarios();');
  pgm.dropTable('historial_recetas');
  pgm.dropTable('historial_usuarios');
  pgm.dropTable('historial_accesos');
  pgm.dropTable('receta_insumos');
  pgm.dropTable('recetas');
  pgm.sql('ALTER TABLE inventario DROP CONSTRAINT IF EXISTS chk_stock_no_negativo;');
  pgm.sql('ALTER TABLE producto_terminado DROP CONSTRAINT IF EXISTS chk_stock_cajas_no_negativo;');
  pgm.sql('ALTER TABLE stock_insumos_refinado DROP CONSTRAINT IF EXISTS chk_stock_refinado_no_negativo;');
};