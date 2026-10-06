/**
 * Estructura del HTML de administracion de usuarios.
 *
 * Lo que se comprueba es el enlace entre el formulario y el backend, no el
 * estilo: nombre, cargo y celular son los tres datos que salen firmados en la
 * orden de compra. Si el admin los llena y no llegan a la base, la OC se
 * imprime con un guion donde deberia ir el nombre de quien la emitio, y como el
 * formulario no da ningun error, nadie se entera hasta que el proveedor la
 * recibe.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGINA = path.join(__dirname, '..', 'public', 'admin.html');
const html = fs.readFileSync(PAGINA, 'utf8');
const sinScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');
const bloquesInline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

const ETIQUETA = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const SIN_CIERRE = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
const idDe = (atributos) => (atributos.match(/id\s*=\s*"([^"]+)"/) || [])[1];

/** Recorre el documento apilando etiquetas, como en la pagina de ordenes. */
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
          const sinCerrar = pila.slice(i + 1).map(p => (p.id ? '#' + p.id : p.etiqueta));
          problemas.push(`al cerrar </${etiqueta}> en la linea ${l + 1} quedaron sin cerrar: ${sinCerrar.join(', ')}`);
        }
        pila.length = i;
      }
    }
  }
  if (pila.length) {
    problemas.push('sin cerrar al final: ' + pila.map(p => (p.id ? '#' + p.id : p.etiqueta)).join(', '));
  }
  return problemas;
}

function stubInfinito() {
  const stub = new Proxy(function () {}, {
    get: (destino, prop) => {
      // then y length tienen que devolver undefined: un then que no es promesa
      // rompe cualquier await y un length inventado rompe el recorrido.
      if (prop === 'then' || prop === 'length') return undefined;
      // El script mete valores en plantillas ("${r}"), asi que el stub tiene que
      // saber convertirse a texto. Sin esto, "Cannot convert object to primitive".
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
      return stub;
    },
    set: () => true,
    apply: () => stub
  });
  return stub;
}

function ejecutarScript() {
  const stub = stubInfinito();
  const contexto = {
    document: stub, window: stub, localStorage: stub, sessionStorage: stub,
    history: stub, location: stub, alert: stub, confirm: () => false, prompt: () => '',
    fetch: () => new Promise(() => {}),
    URLSearchParams,
    setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => 0, clearInterval: () => 0,
    getComputedStyle: () => stub, requestAnimationFrame: () => 0, crypto: stub, console,
    registrarAutoRefresco: () => {}, limpiarSesion: () => {}
  };
  vm.createContext(contexto);
  for (const bloque of bloquesInline) vm.runInContext(bloque, contexto, { timeout: 5000 });
  return contexto;
}

// Los cuatro datos que salen firmados en la OC. El correo se sumo cuando el
// encabezado derecho pidio "E-MAIL" junto a HORA y a la fecha de entrega. La
// columna se llama Correo pero el campo que manda el servidor es email.
const CAMPOS = ['Nombre', 'Cargo', 'Celular', 'Correo'];
const CAMPOS_API = ['nombre', 'cargo', 'celular', 'email'];

describe('admin.html estructura', () => {
  test('el HTML esta balanceado', () => {
    expect(recorrer()).toEqual([]);
  });

  test('no hay ids repetidos', () => {
    const todos = [...sinScripts.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const repetidos = todos.filter((x, i) => todos.indexOf(x) !== i);
    expect([...new Set(repetidos)]).toEqual([]);
  });

  test('todo id que busca el JS existe en el HTML', () => {
    const ids = new Set([...sinScripts.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const js = bloquesInline.join('\n');
    const usados = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
    const faltan = [...new Set(usados)].filter(id => !ids.has(id));
    expect(faltan).toEqual([]);
  });
});

describe('admin.html datos de contacto para la OC', () => {
  test('crear usuario tiene los cuatro campos', () => {
    for (const id of ['nuevoNombre', 'nuevoCargo', 'nuevoCelular', 'nuevoEmail']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('editar usuario tiene los cuatro campos', () => {
    for (const id of ['editNombre', 'editCargo', 'editCelular', 'editEmail']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('el listado de usuarios muestra los cuatro datos', () => {
    for (const campo of CAMPOS) {
      expect(html).toContain(`<th>${campo}</th>`);
    }
  });

  test('crear y editar los mandan al backend', () => {
    const crear = bloquesInline.join('\n');
    // El controlador guarda nombre, cargo, celular y correo; si el admin no los
    // manda, se guardan como null y la OC imprime el guion de "sin dato".
    expect(crear).toContain('JSON.stringify({ usuario, password, rol, nombre, cargo, celular, email })');
    expect(crear).toContain('JSON.stringify({ usuario, rol, password, nombre, cargo, celular, email })');
  });

  test('abrir la edicion los rellena con lo que ya tiene el usuario', () => {
    const fuente = vm.runInContext('abrirEditarUsuario.toString()', ejecutarScript());
    for (const id of ['editNombre', 'editCargo', 'editCelular', 'editEmail']) {
      expect(fuente).toContain(`'${id}'`);
    }
    // Sin el || '' un null dejaria "null" escrito en el campo.
    expect(fuente).toContain("u.celular || ''");
    expect(fuente).toContain("u.email || ''");
  });

  test('el listado escapa los datos que vienen del servidor', () => {
    const fuente = vm.runInContext('renderUsuarios.toString()', ejecutarScript());
    // Un nombre con "<" o un salto de linea romperia la tabla si se inserta tal cual.
    expect(fuente).toContain('esc(');
    for (const campo of CAMPOS_API) expect(fuente).toContain(`u.${campo}`);
  });

  test('esc escapa los cinco caracteres que rompen HTML', () => {
    const fuente = vm.runInContext('esc.toString()', ejecutarScript());
    for (const trozo of ['&', '<', '>', '"', "'"]) {
      expect(fuente).toContain(`/${trozo === "'" ? "'" : trozo}/g`);
    }
  });

  test('la tabla de usuarios no se desalinea: cabecera, fila y colspan', () => {
    // admin.html tiene mas de una tabla, asi que la cabecera se busca por la que
    // precede a este tbody y no por el primer <thead> del archivo.
    const antes = sinScripts.slice(0, sinScripts.indexOf('<tbody id="tablaUsuarios"'));
    const theads = [...antes.matchAll(/<thead>[\s\S]*?<\/thead>/g)];
    expect(theads.length).toBeGreaterThan(0);
    const columnas = (theads[theads.length - 1][0].match(/<th\b/g) || []).length;

    const fuente = vm.runInContext('renderUsuarios.toString()', ejecutarScript());
    // Todas las celdas de la fila menos la unica con colspan, que es el
    // "no hay usuarios" y no es una columna. La de Acciones lleva class, asi
    // que hay que aceptar <td> y <td ...>.
    const celdas = (fuente.match(/<td(?![^>]*colspan)[^>]*>/g) || []).length;
    expect(columnas).toBe(celdas);
    // Los "no hay usuarios" tienen que cubrir la fila entera.
    expect(fuente).toContain(`colspan="${columnas}"`);
    expect(html).toContain(`colspan="${columnas}"`);
  });
});