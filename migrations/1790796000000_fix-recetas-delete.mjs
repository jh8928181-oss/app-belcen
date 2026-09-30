export const up = (pgm) => {
  // El trigger AFTER DELETE insertaba un registro en historial_recetas referenciando
  // la receta ya eliminada, violando la FK. Se quita el DELETE del trigger y se elimina
  // la FK: la ruta DELETE inserta el registro de auditoría explícitamente antes de borrar
  // (receta_id queda como referencia al id removido, tipo "tumba"; los ids son seriales y no se reutilizan).
  pgm.sql('ALTER TABLE historial_recetas DROP CONSTRAINT IF EXISTS historial_recetas_receta_id_fkey;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_historial_recetas ON recetas;');
  pgm.sql(`
    CREATE TRIGGER trg_historial_recetas AFTER INSERT OR UPDATE ON recetas
    FOR EACH ROW EXECUTE FUNCTION trg_historial_recetas();
  `);
};

export const down = (pgm) => {
  // Las auditorías de DELETE apuntan al id eliminado (tipo "tumba"). Sin borrarlas,
  // re-agregar la FK fallaría por Violación de llave foránea.
  pgm.sql('DELETE FROM historial_recetas h WHERE h.receta_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recetas r WHERE r.id = h.receta_id);');
  pgm.sql('DROP TRIGGER IF EXISTS trg_historial_recetas ON recetas;');
  pgm.sql(`
    CREATE TRIGGER trg_historial_recetas AFTER INSERT OR UPDATE OR DELETE ON recetas
    FOR EACH ROW EXECUTE FUNCTION trg_historial_recetas();
  `);
  pgm.sql('ALTER TABLE historial_recetas ADD CONSTRAINT historial_recetas_receta_id_fkey FOREIGN KEY (receta_id) REFERENCES recetas(id);');
};