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

  test('las filas sin vínculo se pueden vincular a mano desde la tabla', () => {
    // red de seguridad: el match automático no decide ante variantes ambiguas
    // o un proveedor que se dio de alta con otra redacción después
    expect(html).toContain('function celdaProveedorAlm(');
    expect(html).toContain('class="sel-vinc-prov"');
    expect(html).toContain('${celdaProveedorAlm(item)}');
    expect(html).toContain('async function vincularIngreso(');
    expect(html).toContain("fetch('/api/auditoria/vincular-ingreso'");
    // tras vincular, la fila se repinta en el sitio con el nombre canónico
    expect(html).toContain('fila.proveedor_id = d.proveedor_id');
  });
});

describe('Carga del catálogo de proveedores desde el Excel de planta', () => {
  const fuente = leer(path.join('migrations', '1792050000000_seed-proveedores-excel.mjs'));

  test('trae los proveedores del Excel, con su RUC y sin duplicados', () => {
    expect(fuente).toContain('const PROVEEDORES');
    expect(fuente).toContain("['EUROPLAST SAC', '20100277213']");
    expect(fuente).toContain("['A2B INDUSTRIAL SAC', '20614029901']");
    // la fila repetida del Excel (mismo RUC) se carga una sola vez
    const cartones = fuente.match(/^\s*\['CARTONES VILLA MARINA/gm) || [];
    expect(cartones.length).toBe(1);
  });

  test('hace upsert por nombre para completar el RUC de lo ya existente', () => {
    expect(fuente).toContain('ON CONFLICT (nombre)');
    expect(fuente).toContain('usuario_registro');
    expect(fuente).toContain("'carga-excel'");
    // CLARIANT cambió de nombre en el Excel: se renombra con sus snapshots
    // antes del upsert para que el RUC caiga en la fila existente
    expect(fuente).toContain("WHERE nombre = 'CLARIANT SAC'");
    expect(fuente).toContain('UPDATE ordenes_compras_servicios');
    expect(fuente).toContain('UPDATE stock_proveedores');
  });

  test('vuelve a rellenar proveedor_id de los ingresos con el catálogo ya cargado', () => {
    // los ingresos que antes quedaban sin vínculo (EUROPLAST, A2B) se
    // resuelven solos al cargar el catálogo del Excel
    expect(fuente).toContain('SET proveedor_id = e.id');
    expect(fuente).toContain('exactos > 0 OR total = 1');
  });

  test('down revierte el renombre y borra solo la fila de la carga', () => {
    expect(fuente).toMatch(/export const down/);
    expect(fuente).toContain("DELETE FROM proveedores WHERE usuario_registro = 'carga-excel'");
    expect(fuente).toContain("SET nombre = 'CLARIANT SAC'");
  });
});

describe('Fusión del proveedor J&M duplicado por variante de nombre', () => {
  const fuente = leer(path.join('migrations', '1792060000000_fix-proveedor-jm-duplicado.mjs'));

  test('borra la fila de carga que comparte RUC con el registro original', () => {
    expect(fuente).toContain("usuario_registro = 'carga-excel'");
    expect(fuente).toContain('otra.ruc = p.ruc AND otra.id < p.id');
  });

  test('conserva el original con el nombre del Excel y sus snapshots', () => {
    expect(fuente).toContain("SET nombre = 'J&M QUIMICOS Y TECNOLOGIA SAC'");
    expect(fuente).toContain("WHERE nombre = 'J & M QUIMICOS Y TECNOLOGIA SAC'");
    expect(fuente).toContain('UPDATE ordenes_compras_servicios');
    expect(fuente).toContain('UPDATE stock_proveedores');
  });
});
