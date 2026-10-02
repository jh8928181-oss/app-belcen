/**
 * Estructura del HTML de Base de Datos General.
 *
 * Estas pruebas existen por un fallo concreto: el div de la pestana de Precios
 * y Facturas se abrio en medio de la tarjeta de ordenes, asi que el pie con
 * "Guardar Orden" y la lista de ordenes quedaron dentro de la pestana de
 * precios. El HTML seguia balanceado (ningun error de sintaxis, el navegador no
 * protestaba) y todas las pruebas de endpoints pasaban, pero al abrir la
 * pestana se veia en blanco. Un archivo HTML no se valida con el parser de JS,
 * asi que hace falta medir el arbol a mano.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGINA = path.join(__dirname, '..', 'public', 'basededatosgeneral.html');
const html = fs.readFileSync(PAGINA, 'utf8');
const sinScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');
const jsInline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const bloquesInline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

// Etiquetas sin etiqueta de cierre propio.
const SIN_CIERRE = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const ETIQUETA = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const idDe = (atributos) => (atributos.match(/id\s*=\s*"([^"]+)"/) || [])[1];

/** Recorre el documento apilando etiquetas. Ignora los script porque el JS trae
 *  cadenas con HTML que falsearian el conteo. */
function recorrer() {
  const pila = [];
  const problemas = [];
  const lineas = sinScripts.split('\n');
  for (let l = 0; l < lineas.length; l++) {
    ETIQUETA.lastIndex = 0;
    let m;
    while ((m = ETIQUETA.exec(lineas[l]))) {
      const [, cierre, etiquetaCruda, atributos] = m;
      const etiqueta = etiquetaCruda.toLowerCase();
      if (SIN_CIERRE.has(etiqueta)) continue;
      const id = idDe(atributos || '');
      if (!cierre) {
        pila.push({ etiqueta, id, linea: l + 1 });
      } else {
        let i = pila.length - 1;
        while (i >= 0 && pila[i].etiqueta !== etiqueta) i--;
        if (i < 0) {
          problemas.push(`cierre sobrante: </${etiqueta}> en la linea ${l + 1}`);
          continue;
        }
        if (i < pila.length - 1) {
          const sinCerrar = pila.slice(i + 1).map(p => p.id ? '#' + p.id : p.etiqueta);
          problemas.push(
            `al cerrar </${etiqueta}> en la linea ${l + 1} quedaron sin cerrar: ${sinCerrar.join(', ')}`
          );
        }
        pila.length = i;
      }
    }
  }
  if (pila.length) {
    problemas.push('sin cerrar al final: ' + pila.map(p => p.id ? '#' + p.id : p.etiqueta).join(', '));
  }
  return problemas;
}


/** Devuelve la ruta de ancestros de un id y su profundidad. */
function rutaDe(idBuscado) {
  const pila = [];
  for (const linea of sinScripts.split('\n')) {
    ETIQUETA.lastIndex = 0;
    let m;
    while ((m = ETIQUETA.exec(linea))) {
      const [, cierre, etiquetaCruda, atributos] = m;
      const etiqueta = etiquetaCruda.toLowerCase();
      if (SIN_CIERRE.has(etiqueta)) continue;
      const id = idDe(atributos || '');
      if (!cierre) {
        if (id === idBuscado) {
          return { ancestros: pila.map(p => p.id ? '#' + p.id : p.etiqueta), profundidad: pila.length };
        }
        pila.push({ etiqueta, id });
      } else {
        let i = pila.length - 1;
        while (i >= 0 && pila[i].etiqueta !== etiqueta) i--;
        if (i >= 0) pila.length = i;
      }
    }
  }
  return null;
}

/** Stub que responde cualquier propiedad o llamada sin romperse, para que el JS
 *  de la pagina corra sin DOM real ni backend. */
function stubInfinito() {
  const stub = new Proxy(function () {}, {
    get: (destino, prop) => (prop === 'then' || prop === 'length' ? undefined : stub),
    set: () => true,
    apply: () => stub
  });
  return stub;
}

/** Ejecuta el script inline de la pagina en un contexto global y lo devuelve.
 *  Sirve para distinguir "la funcion esta declarada" de "esta declarada en el
 *  ambito global": un onclick solo la encuentra si es global. */
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
    // Nunca resuelve: el script dispara peticiones al cargar y aqui no hay backend.
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
    // Los aporta auth-client.js en el navegador, no esta pagina.
    registrarAutoRefresco: () => {},
    limpiarSesion: () => {}
  };
  vm.createContext(contexto);
  for (const bloque of bloquesInline) vm.runInContext(bloque, contexto, { timeout: 5000 });
  return contexto;
}

const PESTANAS = ['pestanaProv', 'pestanaOrden', 'pestanaStock', 'pestanaPrecio'];

describe('basededatosgeneral.html estructura', () => {
  test('el HTML esta balanceado, sin cierres sobrantes ni sin cerrar', () => {
    expect(recorrer()).toEqual([]);
  });

  test('las cuatro pestanas son hermanas al mismo nivel', () => {
    const niveles = PESTANAS.map(id => ({ id, ...rutaDe(id) }));
    for (const n of niveles) expect(n.profundidad).not.toBeNull();

    const profundidadComun = niveles[0].profundidad;
    for (const n of niveles) {
      expect(`${n.id}: ${n.profundidad}`).toBe(`${n.id}: ${profundidadComun}`);
      // Si una cae dentro de otra, al abrir esa se oculta: por eso se ven en blanco.
      expect(n.ancestros).not.toContain('#pestanaOrden');
      expect(n.ancestros).not.toContain('#pestanaPrecio');
      expect(n.ancestros).not.toContain('#pestanaStock');
      expect(n.ancestros).not.toContain('#pestanaProv');
    }
  });

  test('el formulario de ordenes y su lista siguen dentro de la pestana de ordenes', () => {
    // El pie con "Guardar Orden" y la tabla de ordenes都属于 a pestanaOrden;
    // que caigan en otra pestana es lo que dejaba la de precios vacia.
    const inicioPrecio = sinScripts.indexOf('<div id="pestanaPrecio"');
    const pieGuardar = sinScripts.indexOf('guardarOrden()');
    const tablaOrdenes = sinScripts.indexOf('id="tablaOrdenes"');

    expect(pieGuardar).toBeGreaterThan(-1);
    expect(tablaOrdenes).toBeGreaterThan(-1);
    expect(pieGuardar).toBeLessThan(inicioPrecio);
    expect(tablaOrdenes).toBeLessThan(inicioPrecio);
  });

  test('los cuatro bloques de precios y facturas viven dentro de su pestana', () => {
    const inicioPrecio = sinScripts.indexOf('<div id="pestanaPrecio"');
    const finPrecio = sinScripts.indexOf('<div id="pestanaStock"');
    for (const id of ['tablaPrecios', 'tablaFacturas', 'tablaResumenFacturas', 'tablaHistorialPrecios']) {
      const pos = sinScripts.indexOf(`id="${id}"`);
      expect(`${id} existe`).toBe(`${id} existe`);
      expect(pos).toBeGreaterThan(inicioPrecio);
      expect(pos).toBeLessThan(finPrecio);
    }
  });

  test('todo id que busca el JS existe en el HTML', () => {
    const ids = new Set([...sinScripts.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const usados = [...jsInline.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
    const faltan = [...new Set(usados)].filter(id => !ids.has(id));
    expect(faltan).toEqual([]);
  });

  test('no hay ids repetidos', () => {
    const todos = [...sinScripts.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const repetidos = todos.filter((x, i) => todos.indexOf(x) !== i);
    expect([...new Set(repetidos)]).toEqual([]);
  });
});

describe('basededatosgeneral.html ambito global', () => {
  test('el script se ejecuta y expone sus funciones globalmente', () => {
    const contexto = ejecutarScript();
    const declaradas = [...new Set(
      [...jsInline.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1])
    )];
    const noGlobales = declaradas.filter(nombre => typeof contexto[nombre] !== 'function');
    // Una llave de cierre faltante anida el resto del script dentro de otra
    // funcion: las declarations existen pero el onclick no las encuentra.
    expect(declaradas.length).toBeGreaterThan(0);
    expect(noGlobales).toEqual([]);
  });

  test('todo manejador inline resuelve a una funcion global', () => {
    const contexto = ejecutarScript();
    const manejadores = [...new Set(
      [...html.matchAll(/on(?:click|change|input|submit|keyup)="([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
    )];
    const rotos = manejadores.filter(nombre => typeof contexto[nombre] !== 'function');

    expect(manejadores.length).toBeGreaterThan(0);
    expect(rotos).toEqual([]);
  });

  test('el estado de edicion de orden, precio y factura vive en el ambito global', () => {
    const contexto = ejecutarScript();
    for (const variable of ['ordenEditando', 'precioEditando', 'facturaEditando', 'proveedoresCache']) {
      expect(`${variable}: ${vm.runInContext(`typeof ${variable}`, contexto)}`)
        .not.toBe(`${variable}: undefined`);
    }
  });

  test('nuevaOrden no quedo partida y limpia todo el formulario', () => {
    const contexto = ejecutarScript();
    const fuente = vm.runInContext('nuevaOrden.toString()', contexto);
    const campos = [
      'ordenTipo', 'ordenNumero', 'ordenFecha', 'ordenProveedor',
      'ordenEstado', 'ordenMoneda', 'ordenIgvPct', 'ordenObs', 'tbodyItemsOrden'
    ];
    const faltan = campos.filter(campo => !fuente.includes(`'${campo}'`));

    expect(faltan).toEqual([]);
    expect(fuente).toContain('agregarFilaItem()');
    expect(fuente).toContain('recalcularTotalOrden()');
  });
});
