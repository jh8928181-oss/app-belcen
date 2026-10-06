/**
 * Estructura de public/vigilancia.html.
 *
 * La pagina se reorganizo como menu + 4 vistas, y el asistente se duplico
 * para insumos y vehiculos. Los fallos tipicos aqui son silenciosos:
 *
 * 1. Un id que el JS busca por getElementById y no existe: no hay error, el
 *    panel simplemente no aparece.
 * 2. Un selector global (document.querySelector('.paso')) que colisiona entre
 *    los dos asistentes y mueve los pasos del wizard equivocado.
 * 3. La barra de pasos visible en el menu, donde no hay asistente.
 *
 * Los tests de abajo fijan el contrato de las 4 vistas, la parametrizacion del
 * wizard (WIZ) y el envio de vehiculos sin mercancia.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGINA = path.join(__dirname, '..', 'public', 'vigilancia.html');
const html = fs.readFileSync(PAGINA, 'utf8');
const bloquesInline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const jsInline = bloquesInline.join('\n');
const cssInline = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

function stubInfinito() {
  const stub = new Proxy(function () {}, {
    get: (destino, prop) => (prop === 'then' || prop === 'length' ? undefined : stub),
    set: () => true,
    apply: () => stub
  });
  return stub;
}

function ejecutarScript() {
  const stub = stubInfinito();
  const contexto = {
    document: stub,
    window: stub,
    localStorage: stub,
    sessionStorage: stub,
    history: stub,
    location: stub,
    alert: stub,
    confirm: () => false,
    prompt: () => '',
    fetch: () => new Promise(() => {}),
    URLSearchParams,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => 0,
    clearInterval: () => 0,
    getComputedStyle: () => stub,
    requestAnimationFrame: () => 0,
    crypto: stub,
    console,
    registrarAutoRefresco: () => {},
    limpiarSesion: () => {}
  };
  vm.createContext(contexto);
  for (const bloque of bloquesInline) {
    try {
      vm.runInContext(bloque, contexto, { timeout: 5000 });
    } catch (e) {
      // Los bloques se declaran con const/let: al pasarlos todos al mismo
      // contexto, un segundo bloque que repita el nombre revienta el vm. No es
      // un fallo de la pagina, asi que se ignora solo ese caso.
      if (!/Identifier.*already been declared/.test(e.toString())) throw e;
    }
  }
  return contexto;
}

describe('Estructura de public/vigilancia.html', () => {
  test('el CSS del menu esta embebido en la pagina', () => {
    expect(cssInline).toMatch(/\.opcion-menu/);
    expect(cssInline).toMatch(/\.opc-naranja/);
    expect(cssInline).toMatch(/\.opc-gris/);
  });

  test('existen el menu y las 4 vistas', () => {
    expect(html).toMatch(/id="menuVigilancia"/);
    expect(html).toMatch(/id="vistaInsumos"/);
    expect(html).toMatch(/id="vistaVehiculo"/);
    expect(html).toMatch(/id="vistaPersonal"/);
    expect(html).toMatch(/id="vistaConsulta"/);
  });

  test('las 4 vistas arrancan ocultas salvo el menu', () => {
    expect(html).toMatch(/id="menuVigilancia"(?![^>]*style="display:\s*none)/);
    for (const vista of ['vistaInsumos', 'vistaVehiculo', 'vistaPersonal', 'vistaConsulta']) {
      expect(html).toMatch(new RegExp(`id="${vista}"[^>]*style="display:\\s*none`));
    }
  });

  test('el menu ofrece las 4 opciones y la de personal va deshabilitada', () => {
    expect(html).toMatch(/Reporte de ingreso de guía/);
    expect(html).toMatch(/Vehículos sin mercancía/);
    expect(html).toMatch(/Consultar ingresos del día/);
    expect(html).toMatch(/id="menuVigilancia"[\s\S]*?mostrarVista\('personal'\)[^>]*disabled/);
  });

  test('los formularios y la barra de pasos existen', () => {
    expect(html).toMatch(/id="formInsumos"/);
    expect(html).toMatch(/id="formVehiculo"/);
    expect(html).toMatch(/id="barraPasos"/);
    expect(html).toMatch(/id="pieVigilancia"/);
  });

  test('la barra de pasos arranca oculta porque solo aplica dentro de un asistente', () => {
    expect(html).toMatch(/id="barraPasos"[^>]*style="display:\s*none/);
  });

  test('el asistente de vehiculos tiene sus 2 pasos y campos', () => {
    expect(html).toMatch(/id="pasoVehiculo"/);
    expect(html).toMatch(/id="pasoVehiculoRevisar"/);
    expect(html).toMatch(/id="veh_placa"/);
    expect(html).toMatch(/id="veh_chofer"/);
  });

  test('el envio de vehiculos va sin items de mercancia', () => {
    expect(jsInline).toMatch(/VEHICULO SIN MERCADERIA/);
  });

  test('el JS declara mostrarMenu, mostrarVista y la tabla WIZ', () => {
    const ctx = ejecutarScript();
    // Las function si quedan como globales del vm; los const no, asi que
    // VISTAS y WIZ se comprueban sobre el fuente.
    expect(typeof ctx.mostrarMenu).toBe('function');
    expect(typeof ctx.mostrarVista).toBe('function');
    expect(typeof ctx.activarWizard).toBe('function');
    expect(jsInline).toMatch(/const VISTAS\s*=\s*\{/);
  });

  test('toda funcion que el markup invoca esta definida', () => {
    const definidas = new Set((jsInline.match(/function\s+[A-Za-z_$][\w$]*/g) || [])
      .map(x => x.replace('function ', '')));
    const invocadas = new Set();
    const re = /(?:onclick|onchange|onsubmit|oninput)="([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const f = /\b([A-Za-z_$][\w$]*)\s*\(/g;
      let x;
      while ((x = f.exec(m[1])) !== null) {
        if (x[1] !== 'getElementById') invocadas.add(x[1]);
      }
    }
    const huerfanas = [...invocadas].filter(n => !definidas.has(n));
    expect(huerfanas).toEqual([]);
  });

  test('no hay ids duplicados en el HTML', () => {
    const vistos = new Set();
    const dups = [];
    const re = /\bid="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (vistos.has(m[1])) dups.push(m[1]);
      vistos.add(m[1]);
    }
    expect(dups).toEqual([]);
  });

  test('todo getElementById del script apunta a un id que existe', () => {
    const ids = new Set();
    const re = /\bid="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) ids.add(m[1]);
    const usados = new Set();
    const re2 = /getElementById\('([^']+)'\)/g;
    while ((m = re2.exec(jsInline)) !== null) usados.add(m[1]);
    const rotos = [...usados].filter(i => !ids.has(i));
    expect(rotos).toEqual([]);
  });

  test('el script inline es sintacticamente valido', () => {
    expect(() => new vm.Script(jsInline)).not.toThrow();
  });

  test('WIZ esta parametrizado para insumos y vehiculo', () => {
    expect(jsInline).toMatch(/const WIZ\s*=\s*\{/);
    expect(jsInline).toMatch(/insumos:\s*\{/);
    expect(jsInline).toMatch(/vehiculo:\s*\{/);
  });

  test('cada asistente busca sus campos con scope, no de forma global', () => {
    // Un querySelector('.paso') global moveria los pasos del wizard equivocado.
    expect(jsInline).not.toMatch(/document\.querySelector\('\.paso'\)/);
    expect(jsInline).not.toMatch(/document\.querySelectorAll\('\.paso'\)/);
  });

  test('admin conserva el enlace al dashboard', () => {
    // El pie se muestra a admin, auditoria, supervisor y produccion; admin entra
    // por la lista blanca de roles y no debe perder el enlace de retroceso.
    const i = html.indexOf("rolUsuario !== 'admin'");
    expect(i).toBeGreaterThan(-1);
    expect(html).toMatch(/id="linkDashboard"/);
  });
});