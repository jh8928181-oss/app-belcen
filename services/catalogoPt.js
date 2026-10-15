// Catálogo de productos terminados tal como los reconoce el lector de guías.
// Una sola fuente de verdad: de aquí sale la lista de claves que el prompt de
// Gemini debe devolver, y de aquí se valida lo que la IA contesta (si manda
// una clave inventada se descarta y el item queda para el resolutor local).
const PRODUCTOS_PT = [
  { product_key: 'b1_200ml', nombre: 'Aceite de Soya B-1 200 ml' },
  { product_key: 'b1_500ml', nombre: 'Aceite de Soya B-1 500 ml' },
  { product_key: 'b1_900ml', nombre: 'Aceite de Soya B-1 900 ml' },
  { product_key: 'b1_1lt', nombre: 'Aceite de Soya B-1 1 Lt' },
  { product_key: 'b1_2lt', nombre: 'Aceite de Soya B-1 2 Lt' },
  { product_key: 'b1_5lt', nombre: 'Aceite de Soya B-1 5 Lt (Galonera)' },
  { product_key: 'donlalo_800ml', nombre: 'Aceite de Soya Don Lalo 800 ml' },
  { product_key: 'donlalo_20lt', nombre: 'Aceite de Soya Don Lalo Balde 20 Lt' },
  { product_key: 'belini_200ml', nombre: 'Aceite de Soya Belini 200 ml' },
  { product_key: 'belini_500ml', nombre: 'Aceite de Soya Belini 500 ml' },
  { product_key: 'belini_900ml', nombre: 'Aceite de Soya Belini 900 ml' },
  { product_key: 'belini_1lt', nombre: 'Aceite de Soya Belini 1 Lt' },
  { product_key: 'belini_2lt', nombre: 'Aceite de Soya Belini 2 Lt (Galonera)' },
  { product_key: 'belini_3lt', nombre: 'Aceite de Soya Belini 3 Lt' },
  { product_key: 'belini_5lt', nombre: 'Aceite de Soya Belini 5 Lt (Galonera)' },
  { product_key: 'belini_lata18lt', nombre: 'Aceite de Soya Belini Lata 18 Lt' },
  { product_key: 'belini_balde18lt', nombre: 'Aceite de Soya Belini Balde 18 Lt' },
  { product_key: 'vega_900ml', nombre: 'Aceite de Soya VEGA 900 ml' },
  { product_key: 'timonel_900ml', nombre: 'Aceite de Soya TIMONEL 900 ml' },
  { product_key: 'fernandez_1lt', nombre: 'Aceite de Soya Fernandez 1 Lt' },
  { product_key: 'faisan_900ml', nombre: 'Aceite de Soya Faisan 900 ml' }
];

const CLAVES_PT = new Set(PRODUCTOS_PT.map(p => p.product_key));

function esClavePt(clave) {
  return typeof clave === 'string' && CLAVES_PT.has(clave);
}

module.exports = { PRODUCTOS_PT, CLAVES_PT, esClavePt };
