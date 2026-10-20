/**
 * Tapa de uso elegible de nuevo en todas las denominaciones que la tenian
 * antes (800 ml, 900 ml, 1 Lt, 500 ml y 3 Lt).
 *
 * El selector del Envasado salia por nombre del producto antes de que la
 * receta mandara; al pasar a receta seleccionable (Faisan) los demas
 * productos quedaron sin opciones y sin selector. Las migraciones marcan la
 * linea de tapa de esas recetas como seleccionable y le ofrecen las tapas
 * dosificadoras N° 26 (o la propia del 3 Lt), conservando la tapa de cada
 * receta como defecto.
 */

const fs = require('fs');
const path = require('path');

const fuente = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '1792070000000_tapa-seleccionable-800-900-1lt.mjs'),
  'utf8'
);
const fuente2 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '1792080000000_tapa-seleccionable-500ml-3lt.mjs'),
  'utf8'
);

describe('Migración: tapa seleccionable en 800/900 ml y 1 Lt', () => {
  test('cubre todos los productos de las tres denominaciones', () => {
    for (const key of ['donlalo_800ml', 'b1_900ml', 'belini_900ml', 'timonel_900ml', 'vega_900ml', 'b1_1lt', 'belini_1lt']) {
      expect(fuente).toContain(`'${key}'`);
    }
    expect(fuente).not.toContain("'faisan_900ml'"); // ya lo trae su propia migracion
  });

  test('marca la linea de tapa seleccionable y ofrece las tapas N° 26', () => {
    expect(fuente).toContain('seleccionable = true');
    expect(fuente).toContain('receta_insumo_opciones');
    // Dorado, Celeste, Rojo y Verde
    for (const id of [35, 36, 68, 69]) expect(fuente).toMatch(new RegExp(`\\b${id}\\b`));
    expect(fuente).toContain('ON CONFLICT');
  });

  test('solo toca lineas de tapa de recetas activas (por nombre, sin asas)', () => {
    expect(fuente).toContain('r.activa = true');
    expect(fuente).toContain("UPPER(inv.nombre) LIKE '%TAPA%'");
    expect(fuente).not.toContain('UPPER(inv.categoria)');
  });

  test('down devuelve las recetas a tapa fija', () => {
    expect(fuente).toMatch(/export const down/);
    expect(fuente).toContain('DELETE FROM receta_insumo_opciones');
    expect(fuente).toContain('seleccionable = false');
  });
});

describe('Migración: tapa seleccionable en 500 ml y 3 Lt', () => {
  test('cubre B1 y Belini 500 ml y Belini 3 Lt', () => {
    for (const key of ['b1_500ml', 'belini_500ml', 'belini_3lt']) {
      expect(fuente2).toContain(`'${key}'`);
    }
  });

  test('500 ml ofrece las tapas N° 26 y el 3 Lt la suya (Celeste 3lt)', () => {
    expect(fuente2).toContain('seleccionable = true');
    expect(fuente2).toContain('receta_insumo_opciones');
    for (const id of [35, 36, 68, 69, 43]) expect(fuente2).toMatch(new RegExp(`\\b${id}\\b`));
    expect(fuente2).toContain('ON CONFLICT');
  });

  test('la linea elegible se elige por NOMBRE de tapa, no por categoria (las asas no)', () => {
    // TAPAS Y ACCESORIOS incluye asas plasticas: marcarlas por categoria
    // dejaba una linea seleccionable con opciones de tapa y descontaba mal.
    expect(fuente2).toContain("UPPER(inv.nombre) LIKE '%TAPA%'");
    expect(fuente2).not.toContain('UPPER(inv.categoria)');
  });

  test('down devuelve las recetas a tapa fija', () => {
    expect(fuente2).toMatch(/export const down/);
    expect(fuente2).toContain('DELETE FROM receta_insumo_opciones');
    expect(fuente2).toContain('seleccionable = false');
  });
});
