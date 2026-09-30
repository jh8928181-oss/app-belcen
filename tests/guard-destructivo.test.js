const { esBaseDeDesarrollo } = require('../scripts/guard-destructivo');

describe('guard-destructivo', () => {
  describe('esBaseDeDesarrollo', () => {
    test('bloquea Supabase de produccion', () => {
      const r = esBaseDeDesarrollo(
        'postgresql://u:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true'
      );
      expect(r.ok).toBe(false);
    });

    test('bloquea Render de produccion', () => {
      const r = esBaseDeDesarrollo('postgresql://u:p@dpg-abc.oregon-postgres.render.com/db_belcen');
      expect(r.ok).toBe(false);
    });

    test('bloquea una base remota sin sufijo de desarrollo', () => {
      const r = esBaseDeDesarrollo('postgresql://u:p@db.example.com:5432/APPBELCEN');
      expect(r.ok).toBe(false);
    });

    test('permite localhost sin importar el nombre', () => {
      expect(esBaseDeDesarrollo('postgresql://u:p@localhost:5432/app_belcen').ok).toBe(true);
      expect(esBaseDeDesarrollo('postgresql://u:p@127.0.0.1:5432/app_belcen').ok).toBe(true);
    });

    test.each([
      ['app_belcen_dev'],
      ['app_belcen_test'],
      ['belcen-testing'],
      ['APP_DEV'],
      ['mi_db_demo'],
      ['datos_sandbox']
    ])('permite la base con sufijo de desarrollo: %s', (db) => {
      const r = esBaseDeDesarrollo('postgresql://u:p@10.0.0.5:5432/' + db);
      expect(r.ok).toBe(true);
      expect(r.motivo).toMatch(/desarrollo/i);
    });

    test('no confunde un sufijo que aparece a mitad de palabra', () => {
      // "development" contiene "dev" pero no es un sufijo con separador.
      const r = esBaseDeDesarrollo('postgresql://u:p@db.example.com:5432/development');
      expect(r.ok).toBe(false);
    });

    test('rechaza una URL invalida', () => {
      expect(esBaseDeDesarrollo('no-es-una-url').ok).toBe(false);
    });

    test('rechaza un DATABASE_URL ausente', () => {
      expect(esBaseDeDesarrollo(undefined).ok).toBe(false);
    });
  });
});
