// Permisos por usuario y módulo: { "almacen": { "ver": true, "editar": false } }.
// Vacío o ausente = se hereda el acceso del rol (comportamiento actual).
// Solo aplica a cuentas NO administradoras: el rol admin siempre pasa.
export const up = (pgm) => {
  pgm.addColumns('usuarios_sistema', {
    permisos: { type: 'jsonb', notNull: true, default: '{}' }
  });
};

export const down = (pgm) => {
  pgm.dropColumns('usuarios_sistema', ['permisos']);
};
