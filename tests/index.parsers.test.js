const {
  parsearCabeceraSUNAT,
  detectarItemsTabla,
  extraerDireccionSUNAT
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
      punto_partida: '', placa: '', chofer: '', licencia: ''
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
