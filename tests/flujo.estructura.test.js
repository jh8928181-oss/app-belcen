/**
 * Estructura de public/flujo.html.
 *
 * El mapa se dibuja con SVG construido a mano y el script inline es largo, asi
 * que hay tres formas de que se rompa en silencio:
 *
 * 1. Un id que el JS busca por getElementById y no existe. No hay error de
 *    sintaxis: el aviso o el panel simplemente no aparece.
 * 2. Un manejador inline (onclick=...) que apunta a una funcion que no quedo
 *    global. El boton se ve bien y no hace nada. Es justo lo que paso en
 *    basededatosgeneral.html con una llave de cierre faltante, y alli no habia
 *    ninguna prueba que lo notara.
 * 3. Desajuste entre la geometria que declara el script y la que dibuja: el
 *    cliente dice que la tarjeta mide una cosa y el render usa otra.
 *
 * Los tests de abajo cubren esas tres, y ademas fijan a proposito los valores
 * de la migracion 1790800004000, porque de eso depende que las columnas del
 * mapa no se pisen entre si.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGINA = path.join(__dirname, '..', 'public', 'flujo.html');
const html = fs.readFileSync(PAGINA, 'utf8');
const sinScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');
const jsInline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const bloquesInline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const cssInline = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

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

/** Ejecuta el script inline en un contexto global y lo devuelve. */
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

/**
 * Lee una expresion dentro del contexto.
 *
 * Hace falta porque en vm los const y let de nivel superior van al ambito lexico
 * del contexto y NO como propiedades del objeto global: leer contexto.ANCHO
 * daria undefined aunque el script declare const ANCHO. Las declaraciones
 * function si quedan como propiedad, y por eso los manejadores inline se
 * comprueban contra contexto[nombre].
 */
const leer = (contexto, expresion) => vm.runInContext(expresion, contexto);

/** Los ids que el script crea en tiempo de ejecucion llevan prefijo fijo. */
const IDS_DINAMICOS = /^(metrica|caja-metrica)-/;

const idsHtml = () => new Set([...sinScripts.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

/** Carga un grafo minimo en el contexto para poder llamar a las funciones de
 *  dibujo sin DOM. */
function cargarGrafo(contexto, nodos, conexiones, etiquetasVisibles = true) {
  leer(contexto, `nodos = ${JSON.stringify(nodos)}; conexiones = ${JSON.stringify(conexiones)}; mostrarEtiquetas = ${etiquetasVisibles};`);
}

describe('flujo.html estructura', () => {
  test('el HTML esta balanceado, sin cierres sobrantes ni sin cerrar', () => {
    const SIN_CIERRE = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr'
    ]);
    const pila = [];
    const problemas = [];

    for (const [indice, linea] of sinScripts.split('\n').entries()) {
      const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
      let m;
      while ((m = re.exec(linea))) {
        const [, cierre, cruda, atributos] = m;
        const etiqueta = cruda.toLowerCase();
        if (SIN_CIERRE.has(etiqueta)) continue;
        const id = (atributos.match(/id\s*=\s*"([^"]+)"/) || [])[1];

        if (!cierre) {
          pila.push({ etiqueta, id });
        } else {
          let i = pila.length - 1;
          while (i >= 0 && pila[i].etiqueta !== etiqueta) i--;
          if (i < 0) {
            problemas.push(`cierre sobrante: </${etiqueta}> en la linea ${indice + 1}`);
            continue;
          }
          if (i < pila.length - 1) {
            const sinCerrar = pila.slice(i + 1).map(p => (p.id ? '#' + p.id : p.etiqueta));
            problemas.push(
              `al cerrar </${etiqueta}> en la linea ${indice + 1} quedaron sin cerrar: ${sinCerrar.join(', ')}`
            );
          }
          pila.length = i;
        }
      }
    }
    if (pila.length) {
      problemas.push('sin cerrar al final: ' + pila.map(p => (p.id ? '#' + p.id : p.etiqueta)).join(', '));
    }
    expect(problemas).toEqual([]);
  });

  test('no hay ids repetidos', () => {
    const todos = [...sinScripts.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const repetidos = todos.filter((x, i) => todos.indexOf(x) !== i);
    expect([...new Set(repetidos)]).toEqual([]);
  });

  test('todo id que busca el JS existe en el HTML', () => {
    const ids = idsHtml();
    const usados = [...jsInline.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
    const faltan = [...new Set(usados)].filter(id => !ids.has(id) && !IDS_DINAMICOS.test(id));
    expect(faltan).toEqual([]);
  });

  test('el panel ofrece los campos nuevos de nodo y de conexion', () => {
    const ids = idsHtml();
    const esperados = [
      // Nodo
      'edResponsable', 'edTiempo', 'edSistema', 'edNotas', 'listaFlujoNodo',
      // Conexion
      'edEvento', 'edCondicion', 'edSla', 'edRespConexion', 'trayectoConexion'
    ];
    expect(esperados.filter(id => !ids.has(id))).toEqual([]);
  });

  test('existen las fichas de hover y el boton de etiquetas', () => {
    const ids = idsHtml();
    expect(['fichaNodo', 'fichaConexion', 'btnEtiquetas'].filter(id => !ids.has(id))).toEqual([]);
  });

  test('la clase que el render marca al seleccionar existe en el CSS', () => {
    // El render agrega "seleccionado"/"seleccionada" como texto plano. Si el CSS
    // se queda con la otra forma, el nodo o la arista no se ven resaltados y no
    // hay ningun error de sintaxis que lo delate.
    const contexto = ejecutarScript();

    expect(contexto.dibujarNodo.toString()).toContain("' seleccionado'");
    expect(cssInline).toMatch(/\.nodo-caja\.seleccionado\b/);

    expect(contexto.dibujarConexion.toString()).toContain("' seleccionada'");
    expect(cssInline).toMatch(/\.conexion\.seleccionada\b/);
  });
});

describe('flujo.html ambito global', () => {
  test('el script se ejecuta y expone sus funciones globalmente', () => {
    const contexto = ejecutarScript();

    // Solo las declaraciones de primer nivel tienen que quedar en el global: hay
    // helpers anidados (mover/soltar del arrastre) que viven dentro de otro
    // function y no se llaman desde ningun manejador. Se distinguen por sangria.
    const declaraciones = [...jsInline.matchAll(/^(\s*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)];
    const sangriaBase = Math.min(...declaraciones.map(m => m[1].length));
    const declaradas = [...new Set(
      declaraciones.filter(m => m[1].length === sangriaBase).map(m => m[2])
    )];
    const noGlobales = declaradas.filter(nombre => typeof contexto[nombre] !== 'function');

    expect(declaradas.length).toBeGreaterThan(0);
    expect(noGlobales).toEqual([]);
  });

  test('todo manejador inline resuelve a una funcion global', () => {
    const contexto = ejecutarScript();
    const manejadores = [...new Set(
      [...html.matchAll(/on(?:click|change|input|submit)="([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
    )];
    const rotos = manejadores.filter(nombre => typeof contexto[nombre] !== 'function');

    expect(manejadores.length).toBeGreaterThan(0);
    expect(rotos).toEqual([]);
  });
});

describe('flujo.html geometria', () => {
  test('la tarjeta y los pasos coinciden con la migracion de posiciones', () => {
    const contexto = ejecutarScript();

    // Valores con los que la migracion 1790800004000 deja el mapa. Si se
    // cambian aqui hay que cambiar la migracion, y al reves.
    const esperado = { ANCHO: 248, ALTO: 118, SEP_X: 336, SEP_Y: 162 };
    for (const [nombre, valor] of Object.entries(esperado)) {
      expect(`${nombre}=${leer(contexto, nombre)}`).toBe(`${nombre}=${valor}`);
    }
  });

  test('deja aire entre nodos de una misma columna y entre columnas', () => {
    const contexto = ejecutarScript();
    const ANCHO = leer(contexto, 'ANCHO');
    const ALTO = leer(contexto, 'ALTO');
    const SEP_X = leer(contexto, 'SEP_X');
    const SEP_Y = leer(contexto, 'SEP_Y');

    // Vertical: los nodos de una columna van a y = 60 + i * SEP_Y.
    expect(SEP_Y).toBeGreaterThan(ALTO);
    // Horizontal: el hueco entre columnas tiene que caber la punta de la flecha
    // y la etiqueta, no solo el ancho de la tarjeta.
    expect(SEP_X - ANCHO).toBeGreaterThanOrEqual(80);
  });

  test('el separador y el chip de metrica caben dentro de la tarjeta', () => {
    const ALTO = leer(ejecutarScript(), 'ALTO');

    // El separador esta en y+82 y el chip en y+89..y+104: ambos por debajo del
    // borde inferior.
    expect(82).toBeLessThan(ALTO);
    expect(104).toBeLessThan(ALTO);
  });

  test('la arista se engancha al borde derecho del origen y al izquierdo del destino', () => {
    const contexto = ejecutarScript();
    const origen = { id: 1, x: 60, y: 100 };
    const destino = { id: 2, x: 396, y: 100 };

    const adelante = leer(contexto, `JSON.stringify(anclajes(${JSON.stringify(origen)}, ${JSON.stringify(destino)}))`);
    expect(JSON.parse(adelante)).toEqual({ x1: 60 + 248, y1: 100 + 59, x2: 396, y2: 159 });

    // Si el destino queda a la izquierda se engancha al borde izquierdo del
    // origen y al derecho del destino, para no cruzar las dos tarjetas.
    const atras = JSON.parse(leer(contexto, `JSON.stringify(anclajes(${JSON.stringify(destino)}, ${JSON.stringify(origen)}))`));
    expect(atras).toEqual({ x1: 396, y1: 159, x2: 60 + 248, y2: 159 });
  });
});

describe('flujo.html detalle de conexiones', () => {
  test('cada tipo tiene punta de flecha y color propio', () => {
    const contexto = ejecutarScript();
    expect(leer(contexto, 'Object.keys(TIPOS)').sort()).toEqual(['decision', 'normal', 'rechazo']);

    // El render referencia el marcador por tipo; si falta uno, esa arista sale
    // sin flecha. El id del marcador se arma con la variable del forEach, y la
    // arista lo busca con el tipo que trae el registro.
    expect(jsInline).toContain("id: 'punta-' + tipo");
    expect(jsInline).toContain("'url(#punta-' + (c.tipo || 'normal') + ')'");
    expect(cssInline).not.toBe('');
  });

  test('el rechazo se dibuja discontinuo y la decision mas gruesa', () => {
    expect(cssInline).toMatch(/\.conexion\.rechazo\s*\{[^}]*stroke-dasharray/);
    expect(cssInline).toMatch(/\.conexion\.decision\s*\{[^}]*stroke-width/);
  });

  test('la etiqueta de una arista lleva el tipo adelante cuando no es normal', () => {
    const contexto = ejecutarScript();
    const etiqueta = contexto.textoEtiquetaConexion;

    // Sin etiqueta propia, una decision dice cual es. Con etiqueta, el tipo la
    // precede: el tipo es lo que ya no se distingue solo por el color.
    expect(etiqueta({ tipo: 'decision' })).toBe('DECISIÓN · Decisión');
    expect(etiqueta({ tipo: 'rechazo' })).toBe('RECHAZO · Rechazo / devolución');
    expect(etiqueta({ tipo: 'normal' })).toBe('Normal');

    expect(etiqueta({ tipo: 'rechazo', etiqueta: 'Merma y descartes' })).toBe('RECHAZO · Merma y descartes');
    expect(etiqueta({ tipo: 'normal', etiqueta: 'Ingreso con guía' })).toBe('Ingreso con guía');
  });

  test('la etiqueta se recorta para que no se salga de la tarjeta', () => {
    const contexto = ejecutarScript();
    const tope = leer(contexto, 'CARACTERES_ETIQUETA');
    const texto = contexto.textoEtiquetaConexion({ tipo: 'normal', etiqueta: 'x'.repeat(200) });

    expect(texto.length).toBeLessThanOrEqual(tope);
    expect(texto.endsWith('…')).toBe(true);
  });

  test('las posiciones de etiqueta se separan cuando chocan', () => {
    const contexto = ejecutarScript();
    // Tres aristas con el mismo punto medio, como las que salen de un nodo.
    cargarGrafo(contexto,
      [{ id: 1, x: 60, y: 100 }, { id: 2, x: 396, y: 100 }],
      [
        { id: 'c1', origen_id: 1, destino_id: 2, tipo: 'normal', etiqueta: 'Uno' },
        { id: 'c2', origen_id: 1, destino_id: 2, tipo: 'rechazo', etiqueta: 'Merma y descartes' },
        { id: 'c3', origen_id: 1, destino_id: 2, tipo: 'decision', etiqueta: 'Proyecta plan' }
      ]
    );

    contexto.calcularEtiquetasConexiones();
    const posiciones = leer(contexto, '[..._posEtiquetas.values()]');

    expect(posiciones).toHaveLength(3);
    for (let i = 0; i < posiciones.length; i++) {
      for (let j = i + 1; j < posiciones.length; j++) {
        const a = posiciones[i];
        const b = posiciones[j];
        const solapan = Math.abs(a.y - b.y) < 19 &&
          Math.abs(a.x - b.x) < (a.ancho + b.ancho) / 2 + 6;
        expect({ par: [i, j], solapan }).toEqual({ par: [i, j], solapan: false });
      }
    }
  });

  test('con las etiquetas apagadas no se calcula ninguna posicion', () => {
    const contexto = ejecutarScript();
    cargarGrafo(contexto,
      [{ id: 1, x: 60, y: 100 }, { id: 2, x: 396, y: 100 }],
      [{ id: 'c1', origen_id: 1, destino_id: 2, tipo: 'normal', etiqueta: 'Uno' }],
      false
    );

    contexto.calcularEtiquetasConexiones();
    expect(leer(contexto, '_posEtiquetas.size')).toBe(0);
  });

  test('el resumen de una arista junta evento y condicion', () => {
    const contexto = ejecutarScript();
    // La condicion se guarda sin el "si" (ver migracion 1790800004000): lo pone
    // el resumen para que la ficha se lea como frase.
    expect(contexto.resumenConexion({ evento: 'Ingreso con guía', condicion: 'pasa inspección' }))
      .toBe('Ingreso con guía · si pasa inspección');
    expect(contexto.resumenConexion({ condicion: 'pasa inspección' })).toBe('si pasa inspección');
    expect(contexto.resumenConexion({})).toBe('');
  });
});

describe('flujo.html ida de los campos nuevos', () => {
  test('guardarAhora envia los cuatro campos de nodo', () => {
    const cuerpo = jsInline.slice(
      jsInline.indexOf('async function guardarAhora'),
      jsInline.indexOf('async function guardarVersion')
    );
    expect(cuerpo).toBeTruthy();

    for (const campo of ['responsable', 'tiempo_estimado', 'sistema', 'notas']) {
      expect(`${campo} en el PUT`).toBe(`${campo} en el PUT`);
      expect(cuerpo).toContain(`${campo}: n.${campo}`);
    }
  });

  test('guardarAhora envia los cuatro campos de conexion', () => {
    const cuerpo = jsInline.slice(
      jsInline.indexOf('async function guardarAhora'),
      jsInline.indexOf('async function guardarVersion')
    );
    expect(cuerpo).toBeTruthy();

    for (const campo of ['evento', 'condicion', 'sla', 'responsable']) {
      expect(`${campo} en el PUT`).toBe(`${campo} en el PUT`);
      expect(cuerpo).toContain(`${campo}: c.${campo}`);
    }
  });

  test('la version guardada se lleva tambien los campos nuevos', () => {
    const cuerpo = jsInline.slice(
      jsInline.indexOf('async function guardarVersion'),
      jsInline.indexOf('async function cargarVersiones')
    );
    expect(cuerpo).toBeTruthy();

    for (const campo of ['responsable', 'tiempo_estimado', 'sistema', 'notas', 'evento', 'condicion', 'sla']) {
      expect(`${campo} en la version`).toBe(`${campo} en la version`);
      expect(cuerpo).toContain(campo);
    }
  });

  test('aplicar la edicion del panel escribe los campos nuevos', () => {
    const contexto = ejecutarScript();
    const ids = idsHtml();

    // El input del panel no siempre se llama como la columna: el tiempo del
    // nodo es edTiempo y el responsable de la arista es edRespConexion.
    const nodos = { responsable: 'edResponsable', tiempo_estimado: 'edTiempo', sistema: 'edSistema', notas: 'edNotas' };
    const conexiones = { evento: 'edEvento', condicion: 'edCondicion', sla: 'edSla', responsable: 'edRespConexion' };

    const fuenteNodo = contexto.aplicarEdicionNodo.toString();
    const fuenteConexion = contexto.aplicarEdicionConexion.toString();

    for (const [campo, input] of Object.entries(nodos)) {
      expect(`${campo}: input`).toBe(`${campo}: input`);
      expect(ids.has(input)).toBe(true);
      expect(fuenteNodo).toContain(`'${input}'`);
      expect(fuenteNodo).toContain(`n.${campo} =`);
    }

    for (const [campo, input] of Object.entries(conexiones)) {
      expect(`${campo}: input`).toBe(`${campo}: input`);
      expect(ids.has(input)).toBe(true);
      expect(fuenteConexion).toContain(`'${input}'`);
      expect(fuenteConexion).toContain(`c.${campo} =`);
    }
  });

  test('la busqueda mira tambien los campos nuevos de nodos y aristas', () => {
    const contexto = ejecutarScript();
    const fuente = contexto.aplicarBusqueda.toString();

    for (const campo of ['n.responsable', 'n.sistema', 'n.tiempo_estimado', 'n.notas',
      'c.evento', 'c.condicion', 'c.sla', 'c.responsable']) {
      expect(`${campo} en la busqueda`).toBe(`${campo} en la busqueda`);
      expect(fuente).toContain(campo);
    }
  });

  test('una coincidencia en una arista resalta tambien sus dos extremos', () => {
    const contexto = ejecutarScript();
    const fuente = contexto.aplicarBusqueda.toString();

    // Sin esto, buscar "merma" (que solo existe en aristas) no encontraria nada.
    expect('busca en las aristas').toBe('busca en las aristas');
    expect(fuente).toMatch(/encontrados\.add\(c\.origen_id\)/);
    expect(fuente).toMatch(/encontrados\.add\(c\.destino_id\)/);
  });

  test('la busqueda no deja variables muertas', () => {
    const contexto = ejecutarScript();
    const fuente = contexto.aplicarBusqueda.toString();
    // Un Set que se llena y nunca se lee es codigo que promete algo que no hace.
    const declarados = [...fuente.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new (?:Set|Map)\(\)/g)].map(m => m[1]);
    expect(declarados.length).toBeGreaterThan(0);
    for (const nombre of declarados) {
      const usos = fuente.split(nombre).length - 1;
      expect(`${nombre}: usos`).toBe(`${nombre}: usos`);
      expect(usos).toBeGreaterThan(1);
    }
  });

  test('atenuar una etiqueta baja el texto, no solo el fondo', () => {
    // Si la clase se pone en el <g> pero el CSS la espera en el rect (o al
    // reves), el texto de las aristas apagadas sigue igual de claro que las del
    // flujo resaltado y la busqueda no filtra nada.
    expect(cssInline).toMatch(/\.grupo-etiqueta\.atenuada\b/);
    expect(cssInline).not.toMatch(/\.etiqueta-fondo\.atenuada\b/);

    const contexto = ejecutarScript();
    const fuente = contexto.aplicarBusqueda.toString();
    expect(fuente).toContain('.grupo-etiqueta[data-id=');
    // La clase atenuada va en el grupo, no en un descendiente.
    expect(fuente).not.toContain('.grupo-etiqueta[data-id=' + '".grupo');
    expect(fuente).not.toMatch(/\.grupo-etiqueta\[data-id=[^\n]*?\]\s+\./);
  });
});
