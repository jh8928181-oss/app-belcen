/**
 * Estructura del control de acceso por rol de las pantallas operativas.
 *
 * Contexto: estas pantallas filtran por rol con la forma
 * 'if (!rol || (rol !== 'x' && ...))' y las listas omitian 'admin'.
 * Como admin1 comparte rol 'admin' con el resto de administradores, el
 * administrador quedaba sin acceso a seis modulos (y el servidor le devolvia
 * un 403 de verdad en refinado, ver middleware.auth.test.js).
 *
 * Lo que se fija aqui:
 *   1. Que 'admin' entre en cada pantalla operativa.
 *   2. Que el administrador conserve el enlace de vuelta al dashboard, que antes
 *      se ocultaba para todo el mundo salvo supervisor y produccion.
 *   3. Que ningun otro rol se haya colado: la lista de cada pantalla debe seguir
 *      siendo exactamente la que habia, mas 'admin'.
 *
 * Es una prueba de texto, no de comportamiento: no ejecuta el HTML. Sirve para
 * que una limpieza posterior no se lleve por delante el acceso del administrador
 * sin que se note en la suite.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

// Las listas de roles de cada pantalla antes de abrirle la puerta a 'admin'.
// Si alguna de estas cambia, es que se rompio el aislamiento a proposito.
const ROLOS_ESPERADOS = {
  'almacen.html': ['admin', 'almacen', 'supervisor', 'produccion'],
  'auditoria.html': ['admin', 'auditoria', 'supervisor', 'produccion'],
  'envasado.html': ['admin', 'envasado', 'supervisor', 'produccion'],
  'refinado.html': ['admin', 'auditoria', 'supervisor', 'produccion', 'refinado'],
  'soplado.html': ['admin', 'soplado', 'supervisor', 'produccion'],
  'vigilancia.html': ['admin', 'vigilancia', 'supervisor', 'produccion']
};

const lineasDe = (archivo) => fs.readFileSync(path.join(PUBLIC, archivo), 'utf8').split(/\r?\n/);

const rolesDe = (linea) => [...String(linea).matchAll(/rolUsuario !== '([^']+)'/g)].map(m => m[1]);

describe('pantallas operativas: el administrador entra', () => {
  Object.entries(ROLOS_ESPERADOS).forEach(([archivo, esperados]) => {
    test(`${archivo} acepta 'admin' y no cambia el resto de la lista`, () => {
      const linea = lineasDe(archivo).find(l => /if \(!rolUsuario \|\|/.test(l));
      expect(linea).toBeDefined();
      expect(rolesDe(linea).sort()).toEqual(esperados.slice().sort());
      expect(rolesDe(linea)).toContain('admin');
    });
  });

  test('basededatosdeplanta.html sigue admitiendo admin (ya lo hacia, sin lista)', () => {
    const linea = lineasDe('basededatosdeplanta.html').find(l => /if \(!rolUsuario \|\|/.test(l));
    expect(linea).toMatch(/rolUsuario === 'vigilancia'/);
    expect(linea).not.toMatch(/!== 'admin'/);
  });
});

describe('pantallas operativas: el administrador puede volver al dashboard', () => {
  const conDashboard = [...Object.keys(ROLOS_ESPERADOS), 'basededatosdeplanta.html'];

  conDashboard.forEach((archivo) => {
    test(`${archivo} no le oculta el enlace al dashboard a 'admin'`, () => {
      const lineas = lineasDe(archivo);
      const i = lineas.findIndex(l => l.includes("getElementById('linkDashboard')"));
      expect(i).toBeGreaterThan(-1);

      // La guarda es la linea 'if (rolUsuario !== ...)' justo por encima.
      let guarda = '';
      for (let k = i - 1; k >= 0; k--) {
        if (/if \(rolUsuario !==/.test(lineas[k])) { guarda = lineas[k]; break; }
      }
      expect(guarda).not.toBe('');
      // La guarda esconde el enlace salvo para los roles que aparecen en ella,
      // asi que 'admin' tiene que estar: es la lista de quien si lo conserva.
      expect(rolesDe(guarda)).toContain('admin');
      expect(rolesDe(guarda).sort()).toEqual(['admin', 'produccion', 'supervisor']);
    });
  });
});

describe('dashboard: el administrador tiene enlace a Base de Datos General', () => {
  const dashboard = lineasDe('dashboard.html');

  test('el enlace existe y arranca oculto', () => {
    const enlace = dashboard.find(l => l.includes('id="btnModuloBdGeneral"'));
    expect(enlace).toBeDefined();
    expect(enlace).toContain('href="basededatosgeneral.html"');
    expect(enlace).toContain('hidden');
  });

  test('se le quita hidden en el mismo bloque que abre Usuarios y Recetas', () => {
    const i = dashboard.findIndex(l => /if \(rolActual === 'admin'\)/.test(l));
    expect(i).toBeGreaterThan(-1);
    const bloque = dashboard.slice(i, i + 6).join('\n');
    expect(bloque).toContain("getElementById('btnModuloUsuarios')");
    expect(bloque).toContain("getElementById('btnModuloRecetas')");
    expect(bloque).toContain("getElementById('btnModuloBdGeneral')");
  });

  test('la tarjeta tiene su propio color para no heredarla de otra', () => {
    expect(dashboard.some(l => l.includes('.a-bdg') && l.includes('--ac:'))).toBe(true);
  });
});