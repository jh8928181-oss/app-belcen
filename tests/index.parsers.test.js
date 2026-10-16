const {
  parsearCabeceraSUNAT,
  detectarItemsTabla,
  extraerDireccionSUNAT,
  resolverItemGuia,
  normalizarRespuestaIA,
  fusionarItemsSalidas,
  normalizarNombreInventario
} = require('../index');

// Fixture con la estructura real que emite SUNAT. La cantidad va al final de la
// fila de productos, separada de la medida del envase, como en la guía original.
const PDF_SIMPLIFICADO = [
  'GUIA DE REMISION ELECTRONICA',
  'N° F001-00012345',
  'Datos del Destinatario: ACEITES DON LALO S.A.C. - REGISTRO UNICO DE CONTRIBUYENTES N° 20545678901',
  'Fecha de inicio de Traslado: 13/05/2026',
  'AV. LOS CIPRESES 450 - LURIGANCHO - PERU',
  'JR. LAS BEGONIAS 123 - LIMA - PERU',
  'Punto de llegada',
  'Número de placa del vehiculo: ABC-1234',
  'Conductor: JUAN CARLOS PEREZ',
  'DNI: 45678912',
  'Número de licencia de conducir: Q12345678',
  'Bienes por Transportar',
  'Cantidad Descripción',
  'B-1 X 200 ML ACEITE DE SOYA 100',
  'Indicador de traslado'
].join('\n');

describe('parsearCabeceraSUNAT', () => {
  test('devuelve un objeto con todas las claves aunque el PDF esté vacío', () => {
    const res = parsearCabeceraSUNAT('');
    expect(res).toEqual({
      numero_guia: '', ruc: '', empresa: '', destino: '',
      punto_partida: '', placa: '', chofer: '', dni_chofer: '', licencia: '',
      orden_compra: '', emisor_ruc: '', es_destinatario_externo: false
    });
  });

  test('extrae número de guía de 8 dígitos', () => {
    expect(parsearCabeceraSUNAT(PDF_SIMPLIFICADO).numero_guia).toBe('F001-00012345');
  });

  test('extrae placa, chofer y licencia', () => {
    const res = parsearCabeceraSUNAT(PDF_SIMPLIFICADO);
    expect(res.placa).toBe('ABC-1234');
    expect(res.chofer).toBe('JUAN CARLOS PEREZ');
    expect(res.licencia).toBe('Q12345678');
  });

  test('identifica la planta Belcen como partida y el destino del cliente como llegada', () => {
    const res = parsearCabeceraSUNAT(PDF_SIMPLIFICADO);
    expect(res.punto_partida).toMatch(/LOS CIPRESES/);
    expect(res.destino).toMatch(/BEGONIAS/);
  });

  test('acepta el formato antiguo T001-123 como número de guía', () => {
    expect(parsearCabeceraSUNAT('GUIA T001 - 4567').numero_guia).toBe('T001-4567');
  });

  test('acepta serie corta tipo T009-842 sin confundirla con placa ni OC', () => {
    expect(parsearCabeceraSUNAT('GUIA T009-842').numero_guia).toBe('T009-842');
    // Placas (sin dígito en el prefijo) y OC no son número de guía.
    expect(parsearCabeceraSUNAT('Marca y Placa : KIA AZS-904').numero_guia).toBe('');
    expect(parsearCabeceraSUNAT('Observaciones : OC:60-2026').numero_guia).toBe('');
  });

  test('cae al regex de RUC suelto cuando no hay bloque de destinatario', () => {
    expect(parsearCabeceraSUNAT('RUC N° 20987654321').ruc).toBe('20987654321');
  });

  test('normaliza la placa quitando espacios y usando mayúsculas', () => {
    expect(parsearCabeceraSUNAT('vehiculo: ABC 1234').placa).toBe('ABC1234');
  });

  test('extrae nombre y RUC con "ÚNICO" con tilde y también sin tilde', () => {
    const conTilde = PDF_SIMPLIFICADO.replace('REGISTRO UNICO', 'REGISTRO ÚNICO');
    const res = parsearCabeceraSUNAT(conTilde);
    expect(res.ruc).toBe('20545678901');
    expect(res.empresa).toBe('ACEITES DON LALO S.A.C.');

    // El OCR y los pdf de proveedor escriben a menudo "UNICO" sin tilde. Antes
    // ese caso caía al regex de RUC suelto, que no aplica porque la etiqueta
    // es "CONTRIBUYENTES", y ambos campos salían vacíos.
    const resSinTilde = parsearCabeceraSUNAT(PDF_SIMPLIFICADO);
    expect(resSinTilde.ruc).toBe('20545678901');
    expect(resSinTilde.empresa).toBe('ACEITES DON LALO S.A.C.');
  });

  // Formato EG07 con destinatario real (cliente externo, no la propia empresa).
  const PDF_EG07 = [
    'CORPORACION DON LALO S.A.C.',
    'RUC N°20609912694',
    'GUIA DE REMISION ELECTRONICA REMITENTE',
    'N° EG07 - 00004480',
    'Fecha y hora de emisión :07/10/2026 05:01 PM',
    'Fecha de inicio de Traslado :07/10/2026',
    'Motivo de Traslado :Venta',
    'Punto de Partida CAL. LOS CIPRESES NRO. 105 Z.I. CAJAMARQUILLA 2DA ETAPA -',
    'LURIGANCHO - LIMA - LIMA',
    'Punto de llegada HUACHO - HUACHO - HUAURA - LIMA',
    'Datos del Destinatario :C.H. RETAIL S.A.C. - REGISTRO ÚNICO DE CONTRIBUYENTES N° 20606990058',
    'Bienes por transportar:',
    'N° Bien normalizado Código de Bien Descripción Detallada Unidad de medida Cantidad',
    '1 NO 1040003 ACEITE DE SOYA DON LALO X 800ML X 12 UND CAJA 600.00',
    'Datos del traslado:',
    'Modalidad de Traslado:Privado',
    'Datos de los vehiculos:',
    'Principal: Numero de placa: AAS936',
    'Datos de los conductores:',
    'Principal: LOMOTE ACUÑA HUGO ROLANDO - DOCUMENTO NACIONAL DE IDENTIDAD N° 40850065',
    'Número de licencia de conducir: Q40850065'
  ].join('\n');

  test('formato EG07: numero, destinatario externo y transporte', () => {
    const res = parsearCabeceraSUNAT(PDF_EG07);
    expect(res.numero_guia).toBe('EG07-00004480');
    expect(res.empresa).toBe('C.H. RETAIL S.A.C.');
    expect(res.ruc).toBe('20606990058');
    expect(res.emisor_ruc).toBe('20609912694');
    expect(res.es_destinatario_externo).toBe(true);
    expect(res.destino).toBe('HUACHO - HUACHO - HUAURA - LIMA');
    expect(res.placa).toBe('AAS936');
    expect(res.chofer).toBe('LOMOTE ACUÑA HUGO ROLANDO');
    expect(res.licencia).toBe('Q40850065');
  });

  test('formato EG07: punto de partida junta la linea de continuacion', () => {
    const res = parsearCabeceraSUNAT(PDF_EG07);
    expect(res.punto_partida).toMatch(/CAL\. LOS CIPRESES/);
    expect(res.punto_partida).toMatch(/LURIGANCHO - LIMA - LIMA/);
    expect(res.punto_partida).not.toMatch(/HUACHO/);
  });

  test('traslado interno (mismo RUC) no marca destinatario externo', () => {
    const interno = PDF_EG07.replace(
      'C.H. RETAIL S.A.C. - REGISTRO ÚNICO DE CONTRIBUYENTES N° 20606990058',
      'CORPORACION DON LALO S.A.C. - REGISTRO ÚNICO DE CONTRIBUYENTES N° 20609912694'
    );
    const res = parsearCabeceraSUNAT(interno);
    expect(res.es_destinatario_externo).toBe(false);
  });

  test('formato EG07: lee el item con unidad CAJA y cantidad 600', () => {
    const res = detectarItemsTabla(PDF_EG07);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].product_key).toBe('donlalo_800ml');
    expect(res.items[0].cantidad).toBe(600);
  });

  // Formato T009 (traslado interno): partida/llegada con P. abreviado.
  const PDF_T009 = [
    'CORPORACION DON LALO S.A.C.',
    'RUC 20609912694',
    'GUIA DE REMISION ELECTRONICA REMITENTE',
    'T009-00000831',
    'DESTINATARIO',
    'Razón Social: CORPORACION DON LALO S.A.C.',
    'RUC: 20609912694',
    'Dirección: CAL. ANDALUCIA NRO. 340, Ate, Lima - LIMA',
    'Fecha Inicio de Traslado: 2026-10-07',
    'P.Partida: 150118 - CAL.LOS CIPRESES NRO. 105 Z.I. CAJAMARQUILLA 2DA ETAPA',
    'P.Llegada: 150101 - AV. LA CULTURA 701 MERCADO DE PRODUCTORE',
    'Número de placa del vehículo: BJP776',
    'Conductor: 60011823',
    'Licencia del conductor: Q60011823'
  ].join('\n');

  test('formato T009: partida y llegada, sin destinatario externo', () => {
    const res = parsearCabeceraSUNAT(PDF_T009);
    expect(res.numero_guia).toBe('T009-00000831');
    expect(res.es_destinatario_externo).toBe(false);
    expect(res.punto_partida).toMatch(/CAL\.LOS CIPRESES/);
    expect(res.destino).toBe('AV. LA CULTURA 701 MERCADO DE PRODUCTORE');
    expect(res.placa).toBe('BJP776');
  });
});

describe('extraerDireccionSUNAT', () => {
  test('devuelve vacíos si no aparece la etiqueta "Punto de ..."', () => {
    expect(extraerDireccionSUNAT(['cualquier cosa', 'otra linea'])).toEqual({ partida: '', llegada: '' });
  });

  test('coloca una única dirección como llegada', () => {
    const resultado = extraerDireccionSUNAT([
      'Fecha de inicio de Traslado: 13/05/2026 AV. UNICA 123 - BELCEN - LIMA',
      'Punto de llegada'
    ]);
    expect(resultado.llegada).toMatch(/UNICA/);
    expect(resultado.partida).toBe('');
  });

  test('reordena para que la planta Belcen quede como partida', () => {
    const resultado = extraerDireccionSUNAT([
      'Fecha de inicio de Traslado: 13/05/2026',
      'JR. LAS BEGONIAS 123 - LIMA - PERU',
      'AV. LOS CIPRESES 450 - LURIGANCHO - PERU',
      'Punto de llegada'
    ]);

    expect(resultado.partida).toMatch(/CIPRESES/);
    expect(resultado.llegada).toMatch(/BEGONIAS/);
  });

  test('separa dos direcciones aunque la localidad tenga varias palabras', () => {
    // "- SAN MARTIN -" y "- CAJAMARQUILLA -" tienen dos y dos palabras. El
    // patrón anterior exigía un segmento de una sola palabra en el medio, así
    // que ninguna de las dos cerraba y ambas se concatenaban en una sola.
    const resultado = extraerDireccionSUNAT([
      'Fecha de inicio de Traslado: 13/05/2026',
      'JR. LAS BEGONIAS 123 - SAN MARTIN - LIMA',
      'AV. LOS CIPRESES 450 - VILLA EL SALVADOR - LURIGANCHO - PERU',
      'Punto de llegada'
    ]);

    expect(resultado.partida).toMatch(/CIPRESES/);
    expect(resultado.llegada).toMatch(/BEGONIAS/);
  });

  test('no inventa una tercera dirección si sobran líneas', () => {
    const resultado = extraerDireccionSUNAT([
      'Fecha de inicio de Traslado: 13/05/2026',
      'JR. LAS BEGONIAS 123 - LIMA',
      'AV. LOS CIPRESES 450 - LURIGANCHO - PERU',
      'AV. SECUNDARIA 999 - CALLAO - PERU',
      'Punto de llegada'
    ]);

    // Solo hay dos campos: la línea sobrante se funde con una de las dos
    // direcciones en vez de crear un tercer destino que la guía no tiene.
    expect(resultado.partida).toMatch(/CIPRESES/);
    expect(resultado.llegada).toMatch(/BEGONIAS/);
    expect(`${resultado.partida} ${resultado.llegada}`).toMatch(/SECUNDARIA/);
  });
});

describe('detectarItemsTabla', () => {
  test('devuelve listas vacías para un texto sin productos', () => {
    const res = detectarItemsTabla('texto sin ninguna tabla de productos');
    expect(res.items).toEqual([]);
    expect(Array.isArray(res.advertencias)).toBe(true);
  });

  test('reconoce un producto conocido y extrae su cantidad', () => {
    const res = detectarItemsTabla(PDF_SIMPLIFICADO);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      product_key: 'b1_200ml',
      cantidad: 100,
      cantidad_auto: true
    });
    expect(res.items[0].nombre).toBe('Aceite de Soya B-1 200 ml');
  });

  test('reconoce VEGA y TIMONEL 900 ml con su cantidad', () => {
    const res = detectarItemsTabla(
      'Bienes por Transportar\nVEGA X 900 ML ACEITE DE SOYA 120\nTIMONEL X 900 ML ACEITE DE SOYA 80\nIndicador de traslado'
    );
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toMatchObject({ product_key: 'vega_900ml', cantidad: 120, cantidad_auto: true });
    expect(res.items[0].nombre).toBe('Aceite de Soya VEGA 900 ml');
    expect(res.items[1]).toMatchObject({ product_key: 'timonel_900ml', cantidad: 80, cantidad_auto: true });
    expect(res.items[1].nombre).toBe('Aceite de Soya TIMONEL 900 ml');
  });

  test('reconoce FERNANDEZ y FAISAN con su cantidad', () => {
    // Estaban en el catálogo de la BD pero sin alias en el lector: la guía
    // salía con la fila marcada "sin reconocer" y el producto no se despachaba.
    const res = detectarItemsTabla(
      'Bienes por Transportar\nACEITE DE SOYA FERNANDEZ X 1LT X 12 UND CAJA 240\nFAISAN X 900 ML ACEITE DE SOYA 150\nIndicador de traslado'
    );
    expect(res.items.map(i => i.product_key)).toEqual(['fernandez_1lt', 'faisan_900ml']);
    expect(res.items[0].cantidad).toBe(240);
    expect(res.items[1].cantidad).toBe(150);
    expect(res.advertencias.filter(a => a.includes('sin reconocer'))).toEqual([]);
  });

  test('no confunde la medida del producto con la cantidad', () => {
    // La presentación ("200 ML") forma parte del alias del producto. Antes se
    // leía el último número de la línea y devolvía 200, que es el tamaño del
    // envase y no las unidades. Ahora, sin columna de cantidad, devuelve null
    // para que la revisión manual la complete.
    const res = detectarItemsTabla('Bienes por Transportar\nB-1 X 200 ML ACEITE DE SOYA\nIndicador de traslado');
    expect(res.items).toHaveLength(1);
    expect(res.items[0].product_key).toBe('b1_200ml');
    expect(res.items[0].cantidad).toBeNull();
    expect(res.items[0].cantidad_auto).toBe(false);
    expect(res.advertencias.join(' ')).toMatch(/sin una cantidad clara/i);
  });

  test('sigue leyendo la cantidad cuando el proveedor la escribe al final', () => {
    const res = detectarItemsTabla('Bienes por Transportar\nB-1 X 200 ML ACEITE DE SOYA 250\nIndicador de traslado');
    expect(res.items[0].product_key).toBe('b1_200ml');
    expect(res.items[0].cantidad).toBe(250);
  });

  test('acepta filas cortas cuando el producto es conocido', () => {
    // "B-1 X 1 LT" tiene 10 caracteres. El mínimo de 15 era para filtrar
    // ruido, no para descartar productos, así que solo se aplica cuando la
    // línea no coincidió con ningún producto del catálogo.
    const res = detectarItemsTabla('Bienes por Transportar\nB-1 X 1 LT\nIndicador de traslado');
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ product_key: 'b1_1lt', cantidad: null });
  });

  test('sigue ignorando el ruido corto que no es un producto', () => {
    const res = detectarItemsTabla('Bienes por Transportar\nP. Unit\nIndicador de traslado');
    expect(res.items).toEqual([]);
  });

  test('sin la cabecera "Bienes por Transportar" escanea todo el documento', () => {
    // Es una degradación deliberada: si no encuentra la sección, no descarta
    // los productos en lugar de devolver una lista vacía.
    const res = detectarItemsTabla('B-1 X 200 ML ACEITE DE SOYA en cantidad 999');
    expect(res.items).toHaveLength(1);
    expect(res.items[0].cantidad).toBe(999);
  });

  test('cuenta como máximo 4 líneas del mismo producto', () => {
    const filas = Array(6).fill('B-1 X 200 ML ACEITE DE SOYA 100').join('\n');
    const res = detectarItemsTabla(`Bienes por Transportar\n${filas}\nIndicador de traslado`);
    expect(res.items).toHaveLength(4);
  });

  test('ignora las líneas de metadatos de la guía', () => {
    const res = detectarItemsTabla(PDF_SIMPLIFICADO);
    const claves = res.items.map((i) => i.product_key);
    expect(claves).not.toContain('b1_1lt');
  });
});

describe('resolverItemGuia', () => {
  const PTS = [{ producto_key: 'vega_900ml', nombre_producto: 'Aceite de Soya VEGA 900 ml' }];
  const INV = [{ id: 7, nombre: 'Tapa Dosif. N° 26 blanco / ROJO' }];

  test('resuelve por alias aunque la IA no mande clave', () => {
    expect(resolverItemGuia('VEGA X 900 ML ACEITE DE SOYA', PTS, INV)).toEqual({ product_key: 'vega_900ml' });
    expect(resolverItemGuia('TIMONEL 900ML', PTS, INV)).toEqual({ product_key: 'timonel_900ml' });
  });

  test('resuelve por nombre de catálogo sin marca', () => {
    expect(resolverItemGuia('VEGA 900 ml', PTS, INV)).toEqual({ product_key: 'vega_900ml' });
  });

  test('resuelve insumos por id cuando no es producto', () => {
    expect(resolverItemGuia('Tapa Dosif. N° 26 blanco / ROJO', PTS, INV)).toEqual({ articulo_id: 7 });
  });

  test('un parecido no vincula: devuelve null', () => {
    expect(resolverItemGuia('VEGA 500 ml', PTS, INV)).toBeNull();
    expect(resolverItemGuia('', PTS, INV)).toBeNull();
  });
});

describe('normalizarRespuestaIA', () => {
  test('traduce los nombres del prompt a la convención interna', () => {
    const ia = {
      campos: { numero_guia: 'T001-1', lugar_partida: 'Lima', punto_llegada: 'Ica', chofer: 'Juan' },
      items: [{ producto: 'VEGA X 900 ML', cantidad: 120 }]
    };
    const r = normalizarRespuestaIA(ia);
    expect(r.campos.partida).toBe('Lima');
    expect(r.campos.destino).toBe('Ica');
    expect(r.items[0].nombre).toBe('VEGA X 900 ML');
    expect(r.items[0].cantidad_guia).toBe(120);
  });

  test('no pisa lo que ya viene en convención interna', () => {
    const ia = {
      campos: { partida: 'A', lugar_partida: 'B', destino: 'C', punto_llegada: 'D' },
      items: [{ nombre: 'X', cantidad_guia: 5, producto: 'Y', cantidad: 9 }]
    };
    const r = normalizarRespuestaIA(ia);
    expect(r.campos.partida).toBe('A');
    expect(r.campos.destino).toBe('C');
    expect(r.items[0].nombre).toBe('X');
    expect(r.items[0].cantidad_guia).toBe(5);
  });

  test('tolera nulo y formas raras sin reventar', () => {
    expect(normalizarRespuestaIA(null)).toBeNull();
    expect(normalizarRespuestaIA({})).toEqual({ campos: { partida: '', destino: '' }, items: [] });
  });

  test('lee los campos en la raíz, como los devuelve el prompt real', () => {
    // El prompt le pide a Gemini un JSON plano (numero_guia, lugar_partida...),
    // sin bloque "campos": antes la cabecera de la IA entera se tiraba porque
    // se leía del sitio que el modelo nunca llena.
    const ia = {
      numero_guia: 'T009-00001234',
      lugar_partida: 'CAL. LOS CIPRESES 105 - LURIGANCHO - LIMA',
      punto_llegada: 'HUACHO - HUACHO - HUAURA - LIMA',
      placa: 'AAS936',
      chofer: 'LOMOTE ACUÑA HUGO ROLANDO',
      items: [{ producto: 'ACEITE DE SOYA B-1', presentacion: 'X 1LT', cantidad: 600, unidad: 'CAJA' }]
    };
    const r = normalizarRespuestaIA(ia);
    expect(r.campos.numero_guia).toBe('T009-00001234');
    expect(r.campos.partida).toMatch(/LOS CIPRESES/);
    expect(r.campos.destino).toMatch(/HUACHO/);
    expect(r.campos.placa).toBe('AAS936');
    expect(r.items[0].nombre).toBe('ACEITE DE SOYA B-1');
    expect(r.items[0].presentacion).toBe('X 1LT');
    expect(r.items[0].cantidad).toBe(600);
  });
});

describe('fusionarItemsSalidas', () => {
  const PTS = [
    { producto_key: 'b1_1lt', nombre_producto: 'Aceite de Soya B-1 1 Lt' },
    { producto_key: 'fernandez_1lt', nombre_producto: 'Aceite de Soya Fernandez 1 Lt' }
  ];
  const INV = [{ id: 12, nombre: 'Botella Belini x 1 Lt' }];

  test('el lector local manda y la IA no duplica lo ya detectado', () => {
    const local = detectarItemsTabla('Bienes por Transportar\nB-1 X 1 LT ACEITE DE SOYA 600\nIndicador de traslado');
    const ia = [{ nombre: 'ACEITE DE SOYA B-1', presentacion: 'X 1LT', cantidad: 600 }];
    const r = fusionarItemsSalidas({ itemsTabla: local.items, itemsIA: ia, pts: PTS, invs: INV });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ product_key: 'b1_1lt', cantidad: 600 });
    expect(r.advertencias).toEqual([]);
  });

  test('la IA aporta el renglón que el local no reconoció', () => {
    // El local no detecta FERNANDEZ si la fila viene en un formato raro; la IA
    // sí lo ve y ahora se fusiona en vez de tirar el trabajo del parser.
    const ia = [
      { nombre: 'ACEITE DE SOYA B-1', presentacion: 'X 1LT', cantidad: 600 },
      { nombre: 'ACEITE DE SOYA FERNANDEZ', presentacion: 'X 1LT', cantidad: 240 }
    ];
    const r = fusionarItemsSalidas({ itemsTabla: [], itemsIA: ia, pts: PTS, invs: INV });
    expect(r.items.map(i => i.product_key)).toEqual(['b1_1lt', 'fernandez_1lt']);
    expect(r.items[1].cantidad).toBe(240);
    expect(r.advertencias).toEqual([]);
  });

  test('un nombre sin presentación no se adivina y queda para revisión', () => {
    const ia = [{ nombre: 'ACEITE DE SOYA B-1', presentacion: '', cantidad: 10 }];
    const r = fusionarItemsSalidas({ itemsTabla: [], itemsIA: ia, pts: PTS, invs: INV });
    expect(r.items[0].product_key).toBe('');
    expect(r.advertencias.join(' ')).toMatch(/Sin producto asociado/);
  });

  test('una clave inventada por la IA se descarta', () => {
    const ia = [{ nombre: 'ACEITE DE SOYA B-1 X 1LT', presentacion: '', product_key: 'clave_inventada', cantidad: 5 }];
    const r = fusionarItemsSalidas({ itemsTabla: [], itemsIA: ia, pts: PTS, invs: INV });
    expect(r.items[0].product_key).toBe('b1_1lt');
  });

  test('avisa cuando la cantidad de la IA no coincide con la del PDF', () => {
    const local = detectarItemsTabla('Bienes por Transportar\nB-1 X 1 LT ACEITE DE SOYA 600\nIndicador de traslado');
    const ia = [{ nombre: 'ACEITE DE SOYA B-1', presentacion: 'X 1LT', cantidad: 500 }];
    const r = fusionarItemsSalidas({ itemsTabla: local.items, itemsIA: ia, pts: PTS, invs: INV });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].cantidad).toBe(600);
    expect(r.advertencias.join(' ')).toMatch(/leyó 600 y la IA 500/);
  });

  test('reconoce insumos de la IA por nombre exacto de inventario', () => {
    // Las tapas y demás insumos no pasan por el catálogo de PT: se enlazan
    // contra inventario por igualdad exacta del nombre.
    const invs = [{ id: 41, nombre: 'Tapa color Rojo 2lt' }];
    const ia = [{ nombre: 'Tapa color Rojo 2lt', presentacion: '', cantidad: 120 }];
    const r = fusionarItemsSalidas({ itemsTabla: [], itemsIA: ia, pts: PTS, invs });
    expect(r.items[0].articulo_id).toBe(41);
    expect(r.items[0].product_key).toBe('');
  });
});

// El matching de productos al ingresar: tildes, espacios y puntuación no
// deben convertir "Tapa balde belini 18-lt." en un artículo distinto.
describe('normalizarNombreInventario', () => {
  test('ignora tildes, mayúsculas, espacios y puntuación', () => {
    const canonico = normalizarNombreInventario('TAPA BALDE BELINI 18LT');
    expect(normalizarNombreInventario('Tápa balde belíni 18-lt.')).toBe(canonico);
    expect(normalizarNombreInventario('  tapa   BALDE,belini 18 lt ')).toBe(canonico);
  });

  test('nombres realmente distintos siguen sin empatar', () => {
    expect(normalizarNombreInventario('Balde Belini 18 lt'))
      .not.toBe(normalizarNombreInventario('Balde Belini 12 lt'));
  });

  test('vacío y null no revientan', () => {
    expect(normalizarNombreInventario('')).toBe('');
    expect(normalizarNombreInventario(null)).toBe('');
    expect(normalizarNombreInventario(undefined)).toBe('');
  });
});
