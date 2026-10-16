/**
 * Estructura de la pantalla de plan de produccion.
 *
 * Comprueba que las tres pantallas queden de acuerdo entre si. El fallo que esto
 * evita: el dashboard muestra la secuencia y el editor que la arma viven en
 * paginas distintas, y si una se queda con los ids viejos la otra lee un elemento
 * que ya no existe y la pantalla queda a medias sin ningun error visible.
 *
 *   - el dashboard es de SOLO LECTURA: no puede pintar controles de edicion;
 *   - el editor de la linea tiene los botones de mover/quitar y el de guardar;
 *   - el toggle del dashboard es un <button> que no envuelve la lista.
 */

const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..', 'public');
const leer = (archivo) => fs.readFileSync(path.join(raiz, archivo), 'utf8');

describe('Plan de produccion: sin editor de secuencia', () => {
  test('el editor se elimino: ni el JS ni su montaje existen', () => {
    expect(fs.existsSync(path.join(raiz, 'plan-linea.js'))).toBe(false);

    const envasado = leer('envasado.html');
    expect(envasado).not.toContain('/plan-linea.js');
    expect(envasado).not.toContain('montarPlanEnvasado');
    expect(envasado).not.toContain('new PlanLinea');
    expect(envasado).not.toContain('id="planEnvasado"');
    expect(envasado).not.toContain('Guardar secuencia');

    // Soplado tampoco lo monta: no tiene recetas, asi que no hay secuencia.
    const soplado = leer('soplado.html');
    expect(soplado).not.toContain('/plan-linea.js');
  });

  test('los estilos del plan siguen para el tablero que si los usa', () => {
    expect(fs.existsSync(path.join(raiz, 'plan-linea.css'))).toBe(true);
    expect(leer('dashboard.html')).toContain('/plan-linea.css');
  });
});

describe('Dashboard: estado de produccion de solo lectura', () => {
  const dashboard = leer('dashboard.html');

  test('el dashboard carga los estilos del plan', () => {
    expect(dashboard).toContain('/plan-linea.css');
  });

  test('el dashboard no monta el editor ni sus controles', () => {
    // Si el dashboard cargara plan-linea.js seria el lugar equivocado para
    // cambiar la secuencia: se edita en la linea, no desde el tablero.
    expect(dashboard).not.toContain('/plan-linea.js');
    expect(dashboard).not.toContain('new PlanLinea');
  });

  test('no hay ningun control de escritura del plan en el dashboard', () => {
    ['Guardar secuencia', 'btn-guardar-plan', 'data-accion="guardar"', 'data-accion="agregar"']
      .forEach(marca => {
        expect(dashboard).not.toContain(marca);
      });
  });

  test('los dos badges de estado siguen presentes', () => {
    expect(dashboard).toContain('id="badgeEnvasado"');
    expect(dashboard).toContain('id="badgeSoplado"');
    expect(dashboard).toContain('badge-marcha');
    expect(dashboard).toContain('badge-parado');
  });

  test('el producto en produccion y la cola tienen sus contenedores', () => {
    expect(dashboard).toContain('id="planActualEnvasado"');
    expect(dashboard).toContain('id="planColaEnvasado"');
    expect(dashboard).toContain('id="planToggleEnvasado"');
  });

  test('la cola arranca oculta y el toggle la declara controlada', () => {
    expect(dashboard).toMatch(/id="planColaEnvasado"[^>]*hidden/);
    expect(dashboard).toMatch(/id="planToggleEnvasado"[^>]*aria-expanded="false"/);
    expect(dashboard).toContain('aria-controls="planColaEnvasado"');
  });

  test('el toggle no envuelve la lista: un button no puede contener un ol', () => {
    const toggle = dashboard.match(/<button[^>]*id="planToggleEnvasado"[\s\S]*?<\/button>/);
    expect(toggle).not.toBeNull();
    expect(toggle[0]).not.toContain('<ol');
    expect(toggle[0]).not.toContain('<li');
  });

  test('soplado dice que no tiene producto en produccion', () => {
    expect(dashboard).toContain('plan-sin-plan');
    // La nota va dentro del bloque de Soplado, no en el de Envasado.
    const bloque = dashboard.match(/<b>\u{1F3ED} Soplado<\/b>[\s\S]*?<\/div>\s*<\/div>/u);
    expect(bloque).not.toBeNull();
    expect(bloque[0]).toContain('plan-sin-plan');
    expect(bloque[0]).not.toContain('planToggle');
  });

  test('ya no se pinta el "Siguiente" en texto libre', () => {
    // Ese texto salia de estado_lineas.proximo_producto y no distinguia el
    // producto en curso del siguiente.
    expect(dashboard).not.toContain('detalleEnvasado');
    expect(dashboard).not.toContain('siguienteEnvasado');
  });

  test('el dashboard lee la secuencia desde la ruta del plan', () => {
    expect(dashboard).toContain("fetch('/api/linea-plan')");
  });
});

describe('Envasado: la cadena la mandan los reportes y el modal', () => {
  const envasado = leer('envasado.html');

  test('no queda editor ni rastro de secuencia editable', () => {
    expect(envasado).not.toContain('id="planEnvasado"');
    expect(envasado).not.toContain('montarPlanEnvasado');
    expect(envasado).not.toContain('Guardar secuencia');
    expect(envasado).not.toContain('Agregar producto');
  });

  test('marcha con producto y modal obligatorio siguen presentes', () => {
    expect(envasado).toContain('id="marchaProducto"');
    expect(envasado).toContain('id="modalSiguiente"');
    expect(envasado).toContain('pedirSiguienteObligatorio');
    expect(envasado).toContain('proximo_producto: prod');
  });

  test('anterior y en-produccion son muestreo de reportes cerrados', () => {
    expect(envasado).toContain('id="anteriorEnvasado"');
    expect(envasado).toContain('id="siguienteEnvasado"');
    expect(envasado).toContain('cerradasConCantidad');
  });
});