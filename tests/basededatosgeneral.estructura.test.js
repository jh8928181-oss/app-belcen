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

/**
 * Datos que imprime la OC.
 *
 * El boton de descarga y los campos nuevos estan atados por id: si un campo se
 * llama distinto en el HTML y en el JS, getElementById devuelve null y el
 * guardado manda "undefined" en vez del dato, sin ningun error visible.
 */
describe('basededatosgeneral.html datos para la OC', () => {
  const CAMPOS_ORDEN = [
    'ordenLugarEntrega', 'ordenFechaEntrega', 'ordenAreaSolicitante',
    'ordenFormaPago', 'ordenHorarioRecepcion', 'ordenAtencion'
  ];

  test('el formulario de orden tiene los seis campos de entrega', () => {
    for (const id of CAMPOS_ORDEN) expect(html).toContain(`id="${id}"`);
  });

  test('guardarOrden manda los seis campos, con el nombre que espera el backend', () => {
    const fuente = vm.runInContext('guardarOrden.toString()', ejecutarScript());
    // El backend lee cuerpo.lugar_entrega, cuerpo.fecha_entrega, etc. Si el JS
    // mandara otro nombre, el PDF saldría con los seis campos vacios.
    const delBody = ['lugar_entrega', 'fecha_entrega', 'area_solicitante', 'forma_pago', 'horario_recepcion', 'atencion'];
    for (const campo of delBody) expect(fuente).toContain(campo);
    for (const id of CAMPOS_ORDEN) expect(fuente).toContain(`'${id}'`);
  });

  test('editarOrden devuelve los seis campos al formulario', () => {
    const fuente = vm.runInContext('editarOrden.toString()', ejecutarScript());
    for (const id of CAMPOS_ORDEN) expect(fuente).toContain(`'${id}'`);
    // La fecha de entrega es una date y no un texto: si se vuelca tal cual, el
    // input la rechaza y al guardar se pierde.
    expect(fuente).toContain('slice(0, 10)');
  });

  test('el boton de generar OC esta en la lista de ordenes', () => {
    expect(html).toContain('descargarOrdenPDF');
    expect(html).toContain('Generar OC');
    // El manejador va con "this" para poder deshabilitarlo mientras se arma el PDF.
    expect(html).toMatch(/onclick="descargarOrdenPDF\(\$\{o\.id\}, this\)"/);
  });

  test('la descarga no usa api() sino fetch, porque la respuesta no es JSON', () => {
    const fuente = vm.runInContext('descargarOrdenPDF.toString()', ejecutarScript());
    // api() hace res.json() y el PDF es binario: fallaria con un error de parseo.
    expect(fuente).not.toContain('api(');
    expect(fuente).toContain('fetch(');
    expect(fuente).toContain('.blob()');
    // El token lo pone auth-client.js al sobreescribir fetch; si se abriera en
    // una pestana, la peticion llegaria sin Authorization y darian 401.
    expect(fuente).not.toContain('window.open');
  });

  test('el nombre del archivo sale del Content-Disposition del servidor', () => {
    const fuente = vm.runInContext('descargarOrdenPDF.toString()', ejecutarScript());
    expect(fuente).toContain('Content-Disposition');
    expect(fuente).toContain('nombreArchivoDesdeContentDisposition');
    expect(fuente).toContain('enlace.download');
    // El objeto temporal hay que liberarlo o el navegador mantiene el PDF en memoria.
    expect(fuente).toContain('URL.revokeObjectURL');
  });

  test('la tabla de cuentas bancarias del proveedor existe y arranca vacia', () => {
    expect(html).toContain('id="tablaCuentasProv"');
    expect(html).toContain('agregarFilaCuentaProv()');
    // Sin cuentas el PDF omite el bloque; el placeholder no es un dato.
    expect(html).toContain('Sin cuentas registradas.');
  });

  test('leerCuentasProv manda banco, tipo, numero, moneda y titular', () => {
    const fuente = vm.runInContext('leerCuentasProv.toString()', ejecutarScript());
    for (const campo of ['banco', 'tipo', 'numero', 'moneda', 'titular']) {
      expect(fuente).toContain(`'${campo}'`);
    }
    // Una fila a medio llenar no debe llegar al backend como cuenta vacia.
    expect(fuente).toContain('filter(');
  });

  test('guardarProveedor manda las cuentas y editarProveedor las vuelve a pintar', () => {
    const guardar = vm.runInContext('guardarProveedor.toString()', ejecutarScript());
    expect(guardar).toContain('cuentas_bancarias');
    expect(guardar).toContain('leerCuentasProv()');

    const editar = vm.runInContext('editarProveedor.toString()', ejecutarScript());
    expect(editar).toContain('cuentas_bancarias');
    expect(editar).toContain('renderCuentasProv');
  });

  test('limpiar el formulario de proveedor tambien vacia las cuentas', () => {
    // Si no, al crear un proveedor nuevo se le guardarian las cuentas del
    // anterior, que es como una cuenta bancaria se termina en la empresa que no
    // es.
    const fuente = vm.runInContext('limpiarFormProveedor.toString()', ejecutarScript());
    expect(fuente).toContain('renderCuentasProv([])');
  });

  test('quitar la ultima fila deja el placeholder, no un tbody vacio', () => {
    const fuente = vm.runInContext('quitarFilaCuentaProv.toString()', ejecutarScript());
    expect(fuente).toContain('renderCuentasProv([])');
  });
});

describe('basededatosgeneral.html estados de pago de la factura', () => {
  /** Opciones de un select del HTML, por id. */
  function opcionesDe(id) {
    const select = sinScripts.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`));
    expect(select).not.toBeNull();
    return [...select[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  }

  /** La cabecera de la tabla que va justo antes de un tbody, por id. */
  function cabeceraDe(tbodyId) {
    const antes = sinScripts.slice(0, sinScripts.indexOf(`<tbody id="${tbodyId}"`));
    const theads = [...antes.matchAll(/<thead>[\s\S]*?<\/thead>/g)];
    expect(theads.length).toBeGreaterThan(0);
    return theads[theads.length - 1][0];
  }

  test('el formulario ofrece los cinco estados', () => {
    expect(opcionesDe('facturaEstado')).toEqual(['PENDIENTE', 'CREDITO', 'PAGADA', 'CANCELADA', 'ANULADA']);
  });

  test('el filtro ofrece los cinco estados mas el de vencidas', () => {
    // La primera opcion vacia es "Todos", que no es un estado.
    expect(opcionesDe('filtroFacturaEstado'))
      .toEqual(['', 'PENDIENTE', 'CREDITO', 'PAGADA', 'CANCELADA', 'ANULADA', 'VENCIDAS']);
  });

  // VENCIDAS no es un estado, es un filtro que cruza las de credito por fecha.
  // Si el select lo mandara al servidor como estado, la API responderia vacio
  // porque ninguna factura se llama asi.
  test('el filtro de vencidas no se confunde con un estado', () => {
    expect(opcionesDe('facturaEstado')).not.toContain('VENCIDAS');
  });

  /** Corre cargarFacturas() de verdad contra un backend falso y devuelve la URL
   *  que se pidio mas el HTML que quedo en la tabla. */
  async function pedirFacturas(estadoSeleccionado, facturas) {
    const contexto = ejecutarScript();
    const peticiones = [];
    const tbody = { innerHTML: 'sin tocar' };
    const porId = {
      filtroFacturaEstado: { value: estadoSeleccionado },
      filtroFacturaProveedor: { value: '' },
      tablaFacturas: tbody
    };
    contexto.document = {
      getElementById: (id) => porId[id] || stubInfinito(),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {}
    };
    contexto.api = (ruta) => {
      peticiones.push(ruta);
      return Promise.resolve({ facturas });
    };
    contexto.etiquetarTablas = () => {};
    await vm.runInContext('cargarFacturas()', contexto, { timeout: 5000 });
    return { url: peticiones[0] || '', tbody: tbody.innerHTML };
  }

  const FACTURA = (serie, extra) => Object.assign({
    id: 1,
    tipo_comprobante: 'FACTURA',
    serie,
    numero: '1',
    fecha_factura: '2026-01-10',
    orden_tipo: 'OC',
    orden_numero: '001',
    proveedor_nombre: 'Proveedor',
    subtotal: 100,
    igv: 18,
    total: 118,
    moneda: 'PEN',
    orden_moneda: 'PEN',
    estado: 'CREDITO',
    fecha_pago: null,
    fecha_vencimiento: '2026-02-10',
    vencida: false,
    orden_por_facturar: 0,
    orden_por_cobrar: 118
  }, extra);

  test('al filtrar por vencidas no se manda VENCIDAS como estado al servidor', async () => {
    // El bug: la API hace estado = 'VENCIDAS', no encuentra nada y la lista
    // queda vacia para siempre aunque haya facturas vencidas.
    const { url, tbody } = await pedirFacturas('VENCIDAS', [
      FACTURA('A001', { id: 1, vencida: true }),
      FACTURA('B002', { id: 2, vencida: false })
    ]);
    expect(url).not.toContain('estado=VENCIDAS');
    // Y aun asi se pinta solo la vencida.
    expect(tbody).toContain('A001');
    expect(tbody).not.toContain('B002');
  });

  test('un estado de verdad si viaja al servidor', async () => {
    // La inversa del anterior: no basta con borrar el filtro siempre.
    const { url } = await pedirFacturas('PAGADA', []);
    expect(url).toContain('estado=PAGADA');
  });

  test('la tabla de facturas no se desalinea: la cabecera, la fila y el colspan', async () => {
    const columnas = cabeceraDe('tablaFacturas').match(/<th\b/g).length;
    // La fila se cuenta sobre el HTML que pinto de verdad, no sobre una regex
    // adivinada: una columna de mas se ve en el navegador, no en el codigo.
    const { tbody } = await pedirFacturas('VENCIDAS', [FACTURA('A001', { vencida: true })]);
    expect(columnas).toBe(12);
    expect(tbody.match(/<td\b/g).length).toBe(12);
    // Los "sin registros" tienen que cubrir la fila entera, tanto el que
    // pinta el JS como el que viene escrito en el HTML.
    const vacio = await pedirFacturas('VENCIDAS', []);
    expect(vacio.tbody).toContain('colspan="12"');
    const cuerpo = sinScripts.slice(sinScripts.indexOf('<tbody id="tablaFacturas"'));
    expect(cuerpo.slice(0, cuerpo.indexOf('</tbody>'))).toContain('colspan="12"');
  });

  test('cada estado tiene su clase de color', () => {
    for (const clase of ['pendiente', 'credito', 'pagada', 'cancelada', 'anulada', 'vencida']) {
      expect(html).toContain(`.estado-factura-${clase} {`);
    }
  });

  test('el badge conoce los cinco estados y el aviso de vencida', () => {
    const fuente = vm.runInContext('estadoFacturaBadge.toString()', ejecutarScript());
    for (const estado of ['PENDIENTE', 'CREDITO', 'PAGADA', 'CANCELADA', 'ANULADA']) {
      expect(fuente).toContain(`${estado}:`);
    }
    expect(fuente).toContain('vencida');
  });

  test('la tabla de facturas separa por facturar de por cobrar', () => {
    const cabecera = cabeceraDe('tablaFacturas');
    expect(cabecera).toContain('Por facturar');
    expect(cabecera).toContain('Por cobrar');
    expect(cabecera).toContain('Vence');
    // El saldo unico que mezclaba las dos deudas no debe quedar en ningun lado.
    expect(html).not.toMatch(/orden_saldo/);
  });

  test('la lista de ordenes muestra por facturar y por cobrar', () => {
    const cabecera = cabeceraDe('tablaOrdenes');
    expect(cabecera).toContain('Por facturar');
    expect(cabecera).toContain('Por cobrar');
  });

  test('sumarDias suma en UTC y devuelve yyyy-mm-dd', () => {
    const contexto = ejecutarScript();
    // Se cruza el cambio de dia de Peru: en hora local, sumar dias sobre una
    // fecha-hora devolveria la fecha anterior.
    const sumar = (fecha, dias) => vm.runInContext(`sumarDias('${fecha}', ${dias})`, contexto);
    expect(sumar('2026-03-01', 30)).toBe('2026-03-31');
    expect(sumar('2026-01-30', 5)).toBe('2026-02-04');
    // 27 de febrero mas dos dias cae en marzo, no en el 29 nonexistent.
    expect(sumar('2026-02-27', 2)).toBe('2026-03-01');
    expect(sumar('basura', 5)).toBe('');
  });

  test('los dias de crédito se traducen a una fecha de vencimiento', () => {
    const fuente = vm.runInContext('calcularVencimientoDesdeDias.toString()', ejecutarScript());
    expect(fuente).toContain('facturaCreditoDias');
    expect(fuente).toContain('facturaFecha');
    expect(fuente).toContain('facturaVencimiento');
    expect(fuente).toContain('sumarDias(');
  });

  test('los campos de crédito se muestran solo cuando el estado es CREDITO', () => {
    const fuente = vm.runInContext('sincronizarCamposCredito.toString()', ejecutarScript());
    expect(fuente).toContain("=== 'CREDITO'");
    expect(fuente).toContain('facturaCreditoDiasWrap');
    expect(fuente).toContain('facturaVencimientoWrap');
  });

  test('guardar la factura manda el vencimiento solo si esta a crédito', () => {
    const fuente = vm.runInContext('guardarFactura.toString()', ejecutarScript());
    expect(fuente).toContain('fecha_vencimiento');
    expect(fuente).toMatch(/estado === 'CREDITO' \? vencimiento : ''/);
    // Sin este chequeo el backend responde 400 y el usuario ve un error seco.
    expect(fuente).toMatch(/estado === 'CREDITO' && !vencimiento/);
  });

  test('cancelar la edicion borra el vencimiento anterior', () => {
    const fuente = vm.runInContext('cancelarEdicionFactura.toString()', ejecutarScript());
    // Si el vencimiento sobrevive, una factura nueva en CREDITO arrastraria el
    // plazo de la factura que se estaba editando antes.
    expect(fuente).toContain('facturaVencimiento');
    expect(fuente).toContain('sincronizarCamposCredito()');
  });

  test('el modal de pagos existe y es alcanzable desde la lista de ordenes', () => {
    expect(html).toContain('id="modalPagos"');
    expect(html).toContain('onclick="abrirPagosOrden(${o.id})"');
    for (const id of ['pagosTotalOrden', 'pagosFacturado', 'pagosPagado', 'pagosPorFacturar', 'pagosPorCobrar', 'tbodyPagosOrden']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('el modal de pagos muestra las cuatro cifras de la orden', () => {
    const fuente = vm.runInContext('abrirPagosOrden.toString()', ejecutarScript());
    for (const campo of ['total_igv', 'facturado', 'pagado', 'por_facturar', 'por_cobrar']) {
      expect(fuente).toContain(campo);
    }
  });

  test('cambiar el estado desde la orden reenvia el resto del documento', () => {
    const fuente = vm.runInContext('cambiarEstadoFacturaDesdeOrden.toString()', ejecutarScript());
    // El PUT revalida numero, subtotal e IGV, asi que mandarlos vacios haria
    // fallar la edicion entera por un simple cambio de estado.
    for (const campo of ['numero', 'subtotal', 'igv_pct', 'tipo_comprobante', 'serie', 'moneda']) {
      expect(fuente).toContain(campo);
    }
    expect(fuente).toContain("'PUT'");
  });

  test('ir a crédito desde el modal pide la fecha en vez de inventarla', () => {
    const fuente = vm.runInContext('cambiarEstadoFacturaDesdeOrden.toString()', ejecutarScript());
    expect(fuente).toContain('prompt(');
    expect(fuente).toContain('sumarDias(');
    // Cancelar el prompt devuelve el select a su estado anterior.
    expect(fuente).toMatch(/if \(respuesta === null\) \{ select\.value = original; return; \}/);
  });

  test('el boton de pagar se apaga en las facturas que no se pueden pagar', () => {
    const fuente = vm.runInContext('cargarFacturas.toString()', ejecutarScript());
    expect(fuente).toContain("['ANULADA', 'CANCELADA']");
  });
});
