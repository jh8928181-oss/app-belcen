/**
 * Estructura del campo de lote en Envasado y Auditoria.
 *
 * El numero de lote vivia dentro del textarea de observaciones ("0885 | Tapa:
 * ..."): no se podia buscar ni auditar. Ahora es campo propio obligatorio.
 * Lo que esto cuida:
 *
 *   - Envasado captura el lote en su propio input y lo envia en el body (en
 *     el registro directo Y en el cierre de una produccion abierta);
 *   - el textarea ya NO pide el numero de lote (doble captura = las dos
 *     fuentes divergen y vuelve el lote escondido en obs);
 *   - el cierre por prompt (producciones abiertas por la marcha, sin
 *     formulario) tambien lo pide antes de cerrar;
 *   - ambas pantallas de Auditoria (Produccion e Historial de cierres) lo
 *     muestran en su propia columna, con la cabecera, la fila y el colspan
 *     alineados.
 */

const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..', 'public');
const leer = (archivo) => fs.readFileSync(path.join(raiz, archivo), 'utf8');

describe('Envasado: el lote es campo propio y obligatorio', () => {
  const html = leer('envasado.html');

  test('el formulario captura el lote en su input, aparte de observaciones', () => {
    expect(html).toMatch(/id="lote"[^>]*required/);
    expect(html).toContain('N° de Lote');
    expect(html).toContain("lote: document.getElementById('lote').value.trim()");
  });

  test('el textarea ya no pide el numero de lote', () => {
    expect(html).not.toContain('Observaciones (N° de Lote');
    expect(html).not.toContain('Ej. Lote: 0885');
  });

  test('la tabla activa muestra el lote en columna propia', () => {
    expect(html).toContain('<th>LOTE</th>');
    expect(html).toContain('<td>${row.lote || \'-\'}</td>');
    expect(html).toContain('colspan="8" class="text-center">Cargando producción');
    expect(html).toContain('colspan="8" class="text-center">No hay registros activos');
  });

  test('el cierre por prompt lo pide y lo manda en el body', () => {
    expect(html).toContain("loteActual = ''");
    expect(html).toContain('N° de lote de');
    expect(html).toContain('El número de lote es obligatorio');
    expect(html).toContain('lote,');
    expect(html).toContain('lote: formData.lote');
  });
});

describe('Auditoria: columna LOTE en Produccion e Historial de cierres', () => {
  const html = leer('auditoria.html');

  test('la tabla de Produccion lleva su cabecera, su fila y el colspan', () => {
    expect((html.match(/>Lote<\/th>/g) || [])).toHaveLength(1);
    expect(html).toContain('<td>${inf.lote || \'-\'}</td>');
    expect(html).toContain('colspan="7" class="text-center">Cargando producción');
    expect(html).toContain('colspan="7" class="text-center sin-registros">No hay producciones');
  });

  test('la busqueda tambien filtra por lote', () => {
    expect(html).toContain("(it.lote || '').toLowerCase().includes(q)");
  });

  test('el detalle de cierres muestra el lote en columna propia', () => {
    expect((html.match(/>LOTE<\/th>/g) || [])).toHaveLength(1);
    expect(html).toContain('<td>${item.lote || \'-\'}</td>');
    expect(html).toContain('colspan="7" class="text-center">Cierre consolidado');
  });
});
