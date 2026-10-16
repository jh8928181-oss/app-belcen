/**
 * Fixtures de los 4 formatos reales de guías de proveedor (fotos del 15/10).
 *
 * Cada formato trae su propio layout: RUC con puntos, destinatario en líneas
 * sueltas, puntos sin "de", tablas ITEM/CODIGO sin "Bienes por transportar",
 * columna PESO tras CANTIDAD y miles con coma ("9,775.000").
 */
const {
  parsearCabeceraSUNAT,
  detectarItemsTabla,
  componerCamposDesdeTexto,
  parseNumeroGuia
} = require('../index');

// EUROPLAST: baldes y tapas (TV01-00006299).
const EUROPLAST_TXT = [
  'EUROPLAST S.A.C.',
  'FABRICA DE ENVASES PLASTICOS',
  'RUC N°20100277213',
  'GUIA DE REMISIÓN ELECTRONICA',
  'TV01-00006299',
  'DESTINATARIO : CORPORACION DON LALO S.A.C.',
  'R.U.C. : 20609912694',
  'ORDEN DE COMPRA : 0374-2026',
  'N° SAP 261000206',
  'FECHA EMISIÓN : 15/10/2026',
  'DATOS DE TRANSPORTE RUC : 20611762306',
  'RAZON SOCIAL : LOGISTICA DE TRANSPORTE Y COMERCIALIZACION RT S.A.C.',
  'PUNTO PARTIDA :Los Hilaneros 151 Urb. Vulcano-Ate-Lima-Lima',
  'PUNTO LLEGADA : CAL.ANDALUCIA NRO. 340 (OVALO MAYORAZGO)-Ate-Lima-Lima',
  'ITEM CÓDIGO DESCRIPCIÓN UNID. CANT.',
  '1 4155724000008 BALDE X 18 LT PP/BLANCO C/ASA ETI/BELINI UNI 867.00',
  '2 414453000002 TAPA DE BALDE X 18 LT PP/AMARILLO 235 GR UNI 867.00'
].join('\n');

// NORTH GRAPHIC: etiquetas con columna PESO (T001-0005658).
const NORTH_TXT = [
  'NORTH GRAPHIC',
  'R.U.C. 20611307382',
  'GUIA DE REMISIÓN ELECTRÓNICA REMITENTE',
  'T001-0005658',
  'Fecha de Emisión : 15/10/2026 Motivo de Traslado : Venta',
  'Punto de Partida',
  'CALLE EL NEVADO NRO 208 URB. LA ENSENADA , LIMA, LA MOLINA',
  'Punto de Llegada',
  'AV. LOS ANDES, LOTIZ. CAJAMARQUILLA 2DA ETAPA LURIGANCHO - CHOSICA - LIMA',
  'Dist.: LA MOLINA Prov.: LIMA Dep.: LIMA',
  'Destinatario : CORPORACION DON LALO S.A.C.',
  'R.U.C. del Destinatario : 20609912694',
  'Orden de Compra : 434-2026',
  'Transportista : NG IMPRESIONES S.A.C.',
  'Marca y Placa : KIA AZS-904',
  'Licencia Conducir : Q 47789431',
  'Conductor : YAPUCHURI',
  'JUSCAMAITA,',
  'CARLOS ALBERTO',
  'ITEM CÓDIGO DESCRIPCIÓN UNID. CANT. PESO',
  '04 15731 ETIQ. BELINI 1 LITRO ACEITE VEGETAL PTA. CORP. BELCEN MLL 150.00 100.00',
  '05 14201 ETIQ. B-1 1 LITRO ACEITE VEGETAL PTA. CORP. BELCEN MLL 100.00 80.00',
  '06 13945 ETIQ. DON LALO 800 ML ACEITE VEGETAL PTA. CORP. BELCEN MLL 100.00 80.00'
].join('\n');

// B&M DYLPLAST: servicio de maquila EG07.
const BM_TXT = [
  'B & M DYLPLAST E.I.R.L.',
  'RUC N°20602465340',
  'GUÍA DE REMISIÓN ELECTRÓNICA REMITENTE',
  'N° EG07 - 00007724',
  'Fecha y hora de emisión : 15/10/2026 04:52 PM',
  'Punto de Partida CAL. LAS MAGNOLIAS MZ. G2 LOTE. 36 - LURIGANCHO - LIMA - LIMA',
  'Fecha de inicio de Traslado :15/10/2026',
  'Punto de llegada CAL. LOS CIPRESES NRO. 105 Z.I. CAJAMARQUILLA 2DA ETAPA - LURIGANCHO - LIMA - LIMA',
  'Datos del Destinatario :CORPORACION DON LALO S.A.C. - REGISTRO ÚNICO DE CONTRIBUYENTES N° 20609912694',
  'Factura N° E001 3850 - RUC N° 20602465340',
  'Bienes por transportar:',
  'N° Bien normalizado Código de Bien Descripción Detallada Unidad de medida Cantidad',
  '1 NO SSP SERV. DE SOPLADO LITRO B1 MILLARES 16.32',
  'Datos de los vehiculos:',
  'Principal: Número de placa: D8Q806',
  'Datos de los conductores:',
  'Principal: PACHECO MENDOZA ELARD JOHNNY - DOCUMENTO NACIONAL DE IDENTIDAD N° 21102930',
  'Número de licencia de conducir: P21102930',
  'Observaciones : SON 80 PQTS X 204 UND',
  'OC:60-2026'
].join('\n');

// CERUTI: cajas con miles con coma (T001-00018737).
const CERUTI_TXT = [
  'CERUTI FABRICA DE ENVASES DE CARTON S.A.',
  'R.U.C. N° 20100172624',
  'GUIA DE REMISION ELECTRONICA REMITENTE',
  'Nro. T001-00018737',
  'Destinatario: CORPORACION DON LALO S.A.C.',
  'RUC: 20609912694',
  'Punto de Partida CAR.CENTRAL KM. 18.5 Z.I. ÑAÑA (AL COSTADO DE LA FCA.UNION) LIMA - LIMA - CHACLACAYO',
  'Punto de Llegada : Los Cipreses # 105, Av. Cajamarquilla Etapa LURIGANCHO LIMA Peru',
  'Fecha Emisión: 2026-10-15',
  'Orden de Compra : 04172026',
  'N° Codigo del Bien Cantidad Unidad Peso Descripción',
  '1 16408 9,775.000 UND Caja de aceite B-1 1LT X 12Unid',
  'TIPO DE TRANSPORTE: Transporte Público',
  'RUC Transportista: 20554121382',
  'Placa Vehiculo : D3F867',
  'Razon Social TRANSPORTES WHUDE S.A.',
  'Licencia del Conductor: Q07750472',
  'DNI Conductor: 07750472'
].join('\n');

describe('parseNumeroGuia', () => {
  test('decimales con punto quedan igual', () => {
    expect(parseNumeroGuia('150.00')).toBe(150);
    expect(parseNumeroGuia('867.00')).toBe(867);
    expect(parseNumeroGuia('16.32')).toBe(16.32);
  });

  test('miles con coma y con punto se normalizan', () => {
    expect(parseNumeroGuia('9,775.000')).toBe(9775);
    expect(parseNumeroGuia('150,00')).toBe(150);
  });

  test('basura devuelve null', () => {
    expect(parseNumeroGuia('')).toBeNull();
    expect(parseNumeroGuia('ABC')).toBeNull();
    expect(parseNumeroGuia('0')).toBeNull();
  });
});

describe('formato EUROPLAST (baldes y tapas)', () => {
  test('cabecera: número, RUC con y sin puntos, destinatario y puntos', () => {
    const r = parsearCabeceraSUNAT(EUROPLAST_TXT);
    expect(r.numero_guia).toBe('TV01-00006299');
    expect(r.emisor_ruc).toBe('20100277213');
    expect(r.empresa).toBe('CORPORACION DON LALO S.A.C.');
    expect(r.ruc).toBe('20609912694');
    expect(r.es_destinatario_externo).toBe(true);
    expect(r.punto_partida).toMatch(/Hilaneros/);
    expect(r.destino).toMatch(/ANDALUCIA/);
    expect(r.orden_compra).toBe('0374-2026');
  });

  test('ítems: balde y tapa con su cantidad', () => {
    const r = componerCamposDesdeTexto(EUROPLAST_TXT);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].cantidad_guia).toBe(867);
    expect(r.items[0].nombre).toMatch(/BALDE X 18 LT/);
    expect(r.items[1].cantidad_guia).toBe(867);
    expect(r.items[1].nombre).toMatch(/TAPA DE BALDE/);
  });
});

describe('formato NORTH GRAPHIC (etiquetas con PESO)', () => {
  test('cabecera con RUC con puntos y conductor multilínea', () => {
    const r = parsearCabeceraSUNAT(NORTH_TXT);
    expect(r.numero_guia).toBe('T001-0005658');
    expect(r.emisor_ruc).toBe('20611307382');
    expect(r.empresa).toBe('CORPORACION DON LALO S.A.C.');
    expect(r.ruc).toBe('20609912694');
    expect(r.punto_partida).toMatch(/NEVADO/);
    expect(r.destino).toMatch(/ANDES/);
    expect(r.chofer).toBe('YAPUCHURI JUSCAMAITA, CARLOS ALBERTO');
    expect(r.placa).toBe('AZS-904');
    expect(r.licencia).toBe('Q47789431');
    expect(r.orden_compra).toBe('434-2026');
  });

  test('ítems: toma CANTIDAD y no el PESO', () => {
    const r = componerCamposDesdeTexto(NORTH_TXT);
    expect(r.items).toHaveLength(3);
    expect(r.items.map(i => i.cantidad_guia)).toEqual([150, 100, 100]);
    expect(r.items[0].nombre).toMatch(/BELINI 1 LITRO/);
  });

  test('la presentación X 12 UND no se lee como cantidad', () => {
    const res = detectarItemsTabla(
      'Bienes por Transportar\nDON LALO X 800 ML ACEITE DE SOYA X 12 UND CAJA 600\nIndicador de traslado'
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0].product_key).toBe('donlalo_800ml');
    expect(res.items[0].cantidad).toBe(600);
  });

  test('cantidad pegada a su unidad con peso detrás', () => {
    const res = detectarItemsTabla(
      'ITEM DESCRIPCIÓN UNID. CANT. PESO\nBELINI X 900 ML ACEITE DE SOYA MLL 150.00 100.00\nIndicador de traslado'
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0].product_key).toBe('belini_900ml');
    expect(res.items[0].cantidad).toBe(150);
  });
});

describe('formato B&M (maquila EG07)', () => {
  test('cabecera: número EG07, chofer por Principal y placa alfanumérica', () => {
    const r = parsearCabeceraSUNAT(BM_TXT);
    expect(r.numero_guia).toBe('EG07-00007724');
    expect(r.chofer).toBe('PACHECO MENDOZA ELARD JOHNNY');
    expect(r.placa).toBe('D8Q806');
    expect(r.licencia).toBe('P21102930');
    expect(r.orden_compra).toBe('60-2026');
    expect(r.destino).toMatch(/CIPRESES/);
  });

  test('ítem de servicio con cantidad en millares', () => {
    const r = componerCamposDesdeTexto(BM_TXT);
    const serv = r.items.find(i => /SOPLADO/i.test(i.nombre));
    expect(serv).toBeDefined();
    expect(serv.cantidad_guia).toBe(16.32);
  });
});

describe('formato CERUTI (cajas con miles)', () => {
  test('cabecera: RUC con puntos, OC y transporte', () => {
    const r = parsearCabeceraSUNAT(CERUTI_TXT);
    expect(r.numero_guia).toBe('T001-00018737');
    expect(r.emisor_ruc).toBe('20100172624');
    expect(r.empresa).toBe('CORPORACION DON LALO S.A.C.');
    expect(r.ruc).toBe('20609912694');
    expect(r.punto_partida).toMatch(/CAR\.CENTRAL/);
    expect(r.destino).toMatch(/Cipreses/);
    expect(r.orden_compra).toBe('04172026');
    expect(r.placa).toBe('D3F867');
    expect(r.licencia).toBe('Q07750472');
    expect(r.dni_chofer).toBe('07750472');
  });

  test('ítems: miles con coma y descripción al final', () => {
    const r = componerCamposDesdeTexto(CERUTI_TXT);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].cantidad_guia).toBe(9775);
    expect(r.items[0].nombre).toMatch(/Caja de aceite B-1 1LT/);
  });
});
