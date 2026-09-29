/**
 * Configuración que se aplica antes de cargar cualquier módulo del proyecto.
 *
 * Es obligatoria porque dos módulos leen process.env al importarse:
 *   - db.js lanza si DATABASE_URL no está definido
 *   - middleware/auth.js fija TOKEN_SECRET al cargarse
 *
 * Estos valores son de prueba: no abren ninguna conexión real porque el pool de
 * pg es perezoso (no conecta hasta el primer query) y los tests que lo usan
 * inyectan un doble con jest.mock('../db').
 */

process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://test:test@localhost:5432/test_belcen';

process.env.TOKEN_SECRET = process.env.TOKEN_SECRET
  || 'secreto-de-pruebas-no-usar-en-produccion';

process.env.NODE_ENV = 'test';
