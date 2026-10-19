/**
 * Tapa de uso elegible de nuevo en 800 ml, 900 ml y 1 Lt.
 *
 * El selector del Envasado salia por nombre del producto antes de que la
 * receta mandara; al pasar a receta seleccionable (Faisan) los demas
 * productos quedaron sin opciones y sin selector. La migracion marca la
 * linea de tapa de esas recetas como seleccionable y le ofrece las cuatro
 * tapas dosificadoras N° 26, conservando la tapa propia de cada receta
 * como defecto.
 */

const fs = require('fs');
const path = require('path');

const fuente = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '1792070000000_tapa-seleccionable-800-900-1lt.mjs'),
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

  test('solo toca lineas de tapa de recetas activas', () => {
    expect(fuente).toContain('r.activa = true');
    expect(fuente).toContain('UPPER(inv.categoria)');
  });

  test('down devuelve las recetas a tapa fija', () => {
    expect(fuente).toMatch(/export const down/);
    expect(fuente).toContain('DELETE FROM receta_insumo_opciones');
    expect(fuente).toContain('seleccionable = false');
  });
});
