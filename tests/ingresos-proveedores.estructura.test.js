/**
 * Ingresos de Almacén separados por proveedor.
 *
 * El proveedor vivía como texto libre copiado de la guía (salía "EUROPLAST"
 * y "EUROPLAST SAC" como cosas distintas), así que los ingresos no se podían
 * separar contra el catálogo de la Base de Datos General. Ahora:
 *
 *   - la migración agrega registro_ingresos_almacen.proveedor_id con FK a
 *     proveedores (ON DELETE SET NULL, no rompe bajas) y rellena lo histórico
 *     con exacto > contenido único, nunca adivinando entre varios;
 *   - Auditoría filtra los ingresos con un select poblado desde el catálogo,
 *     pinta el nombre canónico, muestra el total del filtro y permite
 *     re-vincular lo que quedó suelto.
 */

const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

describe('Migración de proveedor_id en registro_ingresos_almacen', () => {
  const fuente = leer(path.join('migrations', '1792040000000_ingresos-proveedor-id.mjs'));

  test('agrega la columna con FK a proveedores y sin romper bajas', () => {
    expect(fuente).toContain('addColumns');
    expect(fuente).toContain('proveedor_id');
    expect(fuente).toContain("references: 'proveedores(id)'");
    expect(fuente).toContain("onDelete: 'SET NULL'");
  });

  test('rellena lo histórico con exacto > contenido único', () => {
    expect(fuente).toContain('SET proveedor_id = e.id');
    expect(fuente).toContain('exactos > 0 OR total = 1');
    expect(fuente).toContain('proveedor_id IS NULL');
    // el backfill corre con pgm (misma transacción que la migración): otra
    // conexión no vería la columna recién agregada
    expect(fuente).toContain('pgm.sql(');
  });

  test('down devuelve el esquema', () => {
    expect(fuente).toMatch(/export const down/);
    expect(fuente).toContain("dropColumns('registro_ingresos_almacen'");
  });
});

describe('Auditoría: el filtro de ingresos por proveedor', () => {
  const html = leer(path.join('public', 'auditoria.html'));

  test('el select del filtro existe con su opción por defecto y su listener', () => {
    expect(html).toContain('id="filtroProvIngresos"');
    expect(html).toContain('<option value="">🏢 Todos los proveedores</option>');
    expect(html).toContain("document.getElementById('filtroProvIngresos').addEventListener('change', renderEntradasAlm);");
  });

  test('las opciones salen del catálogo de la BD General y cuentan lo sin vínculo', () => {
    expect(html).toContain("fetch('/api/auditoria/proveedores')");
    expect(html).toContain('proveedoresFiltro.map(');
    expect(html).toContain('Sin vínculo con el catálogo (');
    // el auto-refresco de 15s repinta el select y no debe perder la selección
    expect(html).toContain('sel.value = Array.prototype.some.call(sel.options');
  });

  test('la tabla filtra por proveedor_id y pinta el nombre canónico', () => {
    expect(html).toContain("provSel === 'sin'");
    expect(html).toContain('String(it.proveedor_id) !== provSel');
    expect(html).toContain("item.proveedor_catalogo || item.proveedor || 'N/D'");
  });

  test('muestra el total del filtro y deja re-vincular lo suelto', () => {
    expect(html).toContain('id="resumenProvIngresos"');
    expect(html).toContain('resumen.textContent');
    expect(html).toContain('onclick="vincularProveedoresAutomatico()"');
    expect(html).toContain("fetch('/api/auditoria/vincular-proveedores', { method: 'POST' })");
  });
});
