// Carga inicial del catálogo de proveedores con la lista del Excel de planta
// (45 proveedores con RUC; CARTONES VILLA MARINA venía dos veces con el mismo
// RUC y se carga una sola). Solo vienen nombre y RUC: contacto, teléfono,
// correo, dirección y cuentas bancarias se completan después desde la pestaña
// de Proveedores de Base de Datos General, que ya permite editarlos.
//
// Los 7 que ya existían en el catálogo no se duplican: el upsert por nombre
// les pone el RUC del Excel, y "CLARIANT SAC" se renombra a la razón social
// del Excel ("CLARIANT PERU SA") manteniendo el snapshot en órdenes y stock.
//
// Al terminar se re-ejecuta el match de proveedor_id de la migración anterior
// contra los ingresos históricos: con EUROPLAST SAC y A2B INDUSTRIAL SAC ya
// en el catálogo, sus guías quedan vinculadas sin esperar al botón.
const SQL_NORM = String.raw`lower(btrim(regexp_replace(translate(coalesce({C}, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUUN'), '\s+', ' ', 'g')))`;

const PROVEEDORES = [
  ['PIZARRO MOPRALES KEVIN', '10742903228'],
  ['CERUTI FABRICA DE ENVASES DE CARTON SA', '20100172624'],
  ['EUROPLAST SAC', '20100277213'],
  ['FABRICA DE ENVASES DE LATA LUX SA', '20100279348'],
  ['ARTECOLA PERU SA', '20100302421'],
  ['PERU OFFSET DIGITAL SAC', '20100853907'],
  ['PAPELERA DEL SUR SA', '20104582428'],
  ['DISTRIBUIDORA CANVAK SAC', '20136457528'],
  ['CARTONES VILLA MARINA SA', '20424964990'],
  ['DISTRIBUIDORA GENERAL SERBECO SAC', '20522044963'],
  ['INVERSIONES LINDA PLAST EIRL', '20544425308'],
  ['AHISA PERU EIRL', '20565999169'],
  ['CORPORACION AQUA ENVIRONMENTAL SAC', '20600146352'],
  ['J&M QUIMICOS Y TECNOLOGIA SAC', '20602317260'],
  ['GRUPO LIDER ONE EIRL', '20606757779'],
  ['MANUFACTURA E INNOVACION QA SAC', '20607388483'],
  ['A2B INDUSTRIAL SAC', '20614029901'],
  ['TRAINVIRIATO SAC', null],
  ['SANCHEZ ASENCIOS VALENTIN', '10805039570'],
  ['QUIMEX SA', '20101200125'],
  ['L+J BAECHLER INGENIEROS SA', '20101965156'],
  ['CLARIANT PERU SA', '20293623431'],
  ['LINDE PERU SRL', '20338570041'],
  ['AMCOR RIGID PACKAGING DEL PERU SA', '20414548491'],
  ['GEKA CORP SAC', '20432427928'],
  ['EMPRESA DE CONSERVAS DE PESCADO BELTRAN EIRL', '20502510470'],
  ['NUVEL SAC', '20507855050'],
  ['SOLPACK SAC', '20507939580'],
  ['SUMINCO SA', '20509685615'],
  ['DAMAR G&L SAC', '20512503382'],
  ['GOLDEN PLAST SAC', '20520832221'],
  ['AVANPLAST SAC', '20549426302'],
  ['COMINSA SAC', '20554387498'],
  ['ALMA UZI EIRL', '20557924451'],
  ['I&TPLASTICS SAC', '20565773861'],
  ['GRAFIFLEX PERU', '20601417619'],
  ['FAST-TECH MAQUINARIAS EIRL', '20606733063'],
  ['GROUP ANISSAC PLAS SAC', '20607210501'],
  ['INVERSIONES E&M SAUÑE SAC', '20609648083'],
  ['NG IMPRESIONES SAC', '20611307382'],
  ['SERVINDUSTRIAS EN GRASAS Y ACEITES SAC', '20611541326'],
  ['INDUSTRIAS DEL ENVASE E & R SAC', null],
  ['MULTISERVICIOS SAUÑE ROJAS SAC', null],
  ['SOLUCIONES QUIMICAS NACIONALES', null],
  ['INDUSTRIAS DEL ENVASE EYR', null]
];

const comilla = (valor) => valor === null || valor === undefined
    ? 'NULL'
    : `'${String(valor).replace(/'/g, "''")}'`;

export const up = (pgm) => {
  // Renombra antes del upsert para que el INSERT choque con el renombrado y
  // le ponga el RUC del Excel en vez de crear una segunda entrada.
  pgm.sql(String.raw`
    UPDATE ordenes_compras_servicios o SET proveedor_nombre = 'CLARIANT PERU SA'
      FROM proveedores p
     WHERE p.id = o.proveedor_id AND p.nombre = 'CLARIANT SAC';
  `);
  pgm.sql(String.raw`
    UPDATE stock_proveedores SET proveedor_nombre = 'CLARIANT PERU SA'
     WHERE lower(btrim(proveedor_nombre)) = 'clariant sac';
  `);
  pgm.sql(String.raw`
    UPDATE proveedores SET nombre = 'CLARIANT PERU SA' WHERE nombre = 'CLARIANT SAC';
  `);

  const valores = PROVEEDORES
    .map(([nombre, ruc]) => `  (${comilla(nombre)}, 'General', ${comilla(ruc)}, 'carga-excel')`)
    .join(',\n');

  pgm.sql(String.raw`
    INSERT INTO proveedores (nombre, categoria, ruc, usuario_registro)
    VALUES
${valores}
    ON CONFLICT (nombre) DO UPDATE SET ruc = COALESCE(EXCLUDED.ruc, proveedores.ruc);
  `);

  const normProveedor = SQL_NORM.replace('{C}', 'r.proveedor');
  const normNombre = SQL_NORM.replace('{C}', 'p.nombre');
  pgm.sql(String.raw`
    WITH norm AS (
      SELECT r.id AS fila_id, ${normProveedor} AS texto
        FROM registro_ingresos_almacen r
       WHERE r.proveedor_id IS NULL
         AND btrim(coalesce(r.proveedor, '')) <> ''
    ), cat AS (
      SELECT p.id, ${normNombre} AS clave
        FROM proveedores p
    ), cand AS (
      SELECT n.fila_id, c.id,
             CASE WHEN c.clave = n.texto THEN 0 ELSE 1 END AS prioridad
        FROM norm n
        JOIN cat c
          ON c.clave = n.texto
          OR (length(c.clave) >= 5 AND length(n.texto) >= 5
              AND (position(n.texto in c.clave) > 0 OR position(c.clave in n.texto) > 0))
    ), elegido AS (
      SELECT fila_id, id FROM (
        SELECT fila_id, id,
               row_number() OVER (PARTITION BY fila_id ORDER BY prioridad, id) AS rn,
               count(*) FILTER (WHERE prioridad = 0) OVER (PARTITION BY fila_id) AS exactos,
               count(*) OVER (PARTITION BY fila_id) AS total
          FROM cand
      ) x
      WHERE rn = 1 AND (exactos > 0 OR total = 1)
    )
    UPDATE registro_ingresos_almacen r
       SET proveedor_id = e.id
      FROM elegido e
     WHERE e.fila_id = r.id;
  `);
};

export const down = (pgm) => {
  // Solo se revierte la carga y el renombre; los proveedores que ya existían
  // antes (CANVAK, SERBECO, QUIMEX, COMINSA, FAST-TECH, J&M) conservan su
  // RUC porque el upsert no marca usuario_registro. Las FK de proveedores son
  // CASCADE o SET NULL, asi que el borrado limpia precios, cuentas e ingresos.
  pgm.sql(String.raw`
    UPDATE ordenes_compras_servicios o SET proveedor_nombre = 'CLARIANT SAC'
      FROM proveedores p
     WHERE p.id = o.proveedor_id AND p.nombre = 'CLARIANT PERU SA';
  `);
  pgm.sql(String.raw`
    UPDATE stock_proveedores SET proveedor_nombre = 'CLARIANT SAC'
     WHERE lower(btrim(proveedor_nombre)) = 'clariant peru sa';
  `);
  pgm.sql(String.raw`
    UPDATE proveedores SET nombre = 'CLARIANT SAC' WHERE nombre = 'CLARIANT PERU SA';
  `);
  pgm.sql(String.raw`
    DELETE FROM proveedores WHERE usuario_registro = 'carga-excel';
  `);
};
