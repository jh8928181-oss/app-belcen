// El reporte de soplado guarda si el lote salio ETIQUETADO (la etiqueta se
// descuenta ahi mismo) o EN BLANCO (se etiqueta despues con
// /api/soplado/etiquetar). Sin esta columna no hay forma de saber desde
// Auditoria de que modo salio cada lote ni que etiqueta se desconto.
// NULL = reporte anterior a esta columna (desconocido).
export const up = (pgm) => {
  pgm.addColumns('reportes_soplado', {
    etiquetada: { type: 'boolean' }
  });
};

export const down = (pgm) => {
  pgm.dropColumns('reportes_soplado', ['etiquetada']);
};
