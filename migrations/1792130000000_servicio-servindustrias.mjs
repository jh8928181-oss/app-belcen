// Servicios externos de soplado: se suma SERVINDUSTRIAS EN GRASAS Y ACEITES
// SAC como tercer servicio al lado de SAUÑE y B&M DYLPLAST. Los CHECK de
// servicios_envios.servicio y servicios_guias.servicio solo aceptaban esos
// dos valores, asi que hay que rehacerlos con la lista nueva.
//
// El nombre del valor se respeta tal cual (minusculas y tildes tal como se
// envia desde el formulario): el servidor compara con trim().toUpperCase().

const LISTA = ['SAUÑE', 'B&M DYLPLAST', 'SERVINDUSTRIAS EN GRASAS Y ACEITES SAC'];
const SQL_IN = `(${LISTA.map(v => `'${v}'`).join(', ')})`;

export const up = (pgm) => {
  pgm.sql('ALTER TABLE servicios_envios DROP CONSTRAINT servicios_envios_servicio_chk;');
  pgm.sql(`ALTER TABLE servicios_envios ADD CONSTRAINT servicios_envios_servicio_chk CHECK (servicio IN ${SQL_IN});`);
  pgm.sql('ALTER TABLE servicios_guias DROP CONSTRAINT servicios_guias_servicio_chk;');
  pgm.sql(`ALTER TABLE servicios_guias ADD CONSTRAINT servicios_guias_servicio_chk CHECK (servicio IN ${SQL_IN});`);
};

export const down = (pgm) => {
  const vieja = "('SAUÑE', 'B&M DYLPLAST')";
  pgm.sql('ALTER TABLE servicios_envios DROP CONSTRAINT servicios_envios_servicio_chk;');
  pgm.sql(`ALTER TABLE servicios_envios ADD CONSTRAINT servicios_envios_servicio_chk CHECK (servicio IN ${vieja});`);
  pgm.sql('ALTER TABLE servicios_guias DROP CONSTRAINT servicios_guias_servicio_chk;');
  pgm.sql(`ALTER TABLE servicios_guias ADD CONSTRAINT servicios_guias_servicio_chk CHECK (servicio IN ${vieja});`);
};
