// El lector de guias (OCR/IA) y la direccion del pedido pueden traer textos
// largos: el INSERT en salidas_almacen reventaba con
// "value too long for type character varying(150)" al registrar el despacho
// (destino y punto_partida son los mas largos de una guia SUNAT).
//
// Solo se ensanchan columnas, nunca se acortan, para no perder datos
// existentes. index.js ademas recorta los valores antes de escribir, como
// red de seguridad.

const NUEVOS = [
  ['destino', 'varchar(500)'],
  ['punto_partida', 'varchar(500)'],
  ['chofer_licencia', 'varchar(300)'],
  ['empresa', 'varchar(250)'],
  ['numero_guia', 'varchar(150)'],
  ['ruc', 'varchar(30)']
];

// Largos originales, para poder volver atras sin romper filas que ya
// guarden textos mas largos que el limite viejo.
const VIEJOS = {
  destino: 150,
  punto_partida: 150,
  chofer_licencia: 150,
  empresa: 150,
  numero_guia: 100,
  ruc: 20
};

export const up = (pgm) => {
  for (const [col, tipo] of NUEVOS) {
    pgm.sql(`ALTER TABLE salidas_almacen ALTER COLUMN ${col} TYPE ${tipo};`);
  }
};

export const down = (pgm) => {
  for (const [col] of NUEVOS) {
    const n = VIEJOS[col];
    pgm.sql(`ALTER TABLE salidas_almacen ALTER COLUMN ${col} TYPE varchar(${n}) USING left(${col}, ${n});`);
  }
};
