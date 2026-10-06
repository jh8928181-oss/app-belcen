// Correo del emisor de la orden de compra.
//
// El encabezado derecho del PDF pide "E-MAIL" junto a HORA y a la fecha de
// entrega. usuarios_sistema guardaba nombre, cargo y celular desde la migracion
// de impresion, pero no el correo, asi que ese renglon solo se podia llenar
// con el override del formulario previo a imprimir.
//
// No es un dato de la cuenta: "admin1" no tiene correo propio, el correo es de
// la persona que firma. Va en la misma tabla que nombre, cargo y celular por la
// misma razon que esos: el emisor sale del login guardado en la orden y asi se
// puede corregir sin volver a emitir.

export const up = (pgm) => {
  pgm.addColumns('usuarios_sistema', {
    email: { type: 'varchar(120)' }
  });
};

export const down = (pgm) => {
  pgm.dropColumns('usuarios_sistema', ['email']);
};