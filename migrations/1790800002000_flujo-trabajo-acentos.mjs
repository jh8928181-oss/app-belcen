/**
 * Corrección de acentuación de la semilla del mapa de flujo.
 *
 * La migración 1790800001000 se aplicó con los textos sin acentos, y como el
 * seed usa ON CONFLICT DO NOTHING no volvía a corregir las filas ya existentes.
 * Este archivo las actualiza en la base ya sembrada; una base creada desde cero
 * ya nace con el archivo anterior corregido.
 *
 * Son solo textos: no cambia claves, areas, metricas ni conexiones, asi que el
 * mapa sigue siendo el mismo.
 *
 * Los valores van en crudo y no como parametros porque pgm.sql de
 * node-pg-migrate no los acepta. Es seguro aqui: son literales de este archivo,
 * no entrada de usuario.
 */

const DESCRIPCIONES = {
  vigilancia: 'Registra el ingreso de la guía y el transportista. Queda pendiente de conformidad.',
  almacen_conformidad: 'Revisa cantidades físicas contra la guía. Confirma o devuelve el ingreso.',
  stock_inventario: 'Nodo central del flujo: todo lo que entra o sale de la planta pasa por aquí.',
  salidas_almacen: 'Despachos con guía. Restan del inventario y quedan pendientes de regularizar.',
  soplado: 'Producción de botellas y preformas con etiqueta automática.',
  envasado: 'Línea de llenado de aceite de soya. Reporta cajas y toneladas por turno.',
  producto_terminado: 'Stock en cajas por presentación. Es la salida de la línea hacia el mercado.',
  recetas: 'Define insumos, merma y stock de seguridad por producto. Gobierna lo que descuenta producción.'
};

function entreComillas(valor) {
  return `'${String(valor).replace(/'/g, "''")}'`;
}

export const up = (pgm) => {
  Object.entries(DESCRIPCIONES).forEach(([clave, descripcion]) => {
    pgm.sql(`UPDATE flujo_nodos SET descripcion = ${entreComillas(descripcion)} WHERE clave = ${entreComillas(clave)}`);
  });

  const nombres = {
    salidas_almacen: 'Salidas de almacén',
    auditoria: 'Auditoría',
    almacen_conformidad: 'Almacén - Conformidad'
  };
  Object.entries(nombres).forEach(([clave, nombre]) => {
    pgm.sql(`UPDATE flujo_nodos SET nombre = ${entreComillas(nombre)} WHERE clave = ${entreComillas(clave)}`);
  });

  const areas = {
    Recepción: ['vigilancia', 'almacen_conformidad', 'registro_ingresos'],
    Almacén: ['stock_proveedores', 'stock_inventario', 'salidas_almacen'],
    Producción: ['soplado', 'envasado', 'refinado', 'produccion', 'producto_terminado']
  };
  Object.entries(areas).forEach(([area, claves]) => {
    const lista = claves.map(entreComillas).join(', ');
    pgm.sql(`UPDATE flujo_nodos SET area = ${entreComillas(area)} WHERE clave IN (${lista})`);
  });

  pgm.sql(`
    UPDATE flujo_conexiones SET etiqueta = 'Ingreso con guía'
    WHERE origen_id = (SELECT id FROM flujo_nodos WHERE clave = 'oc_os')
      AND destino_id = (SELECT id FROM flujo_nodos WHERE clave = 'vigilancia')
  `);
};

export const down = () => {
  // Revertir aquí significaría volver a escribir los textos sin acentos, que es
  // justo lo que esta migración corrige. Se deja sin reversa a propósito.
};
