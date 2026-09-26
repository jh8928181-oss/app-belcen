/**
 * Utilidades compartidas para normalización y validación
 */

/**
 * Normaliza un string para comparación insensible a mayúsculas, acentos, signos y espacios
 * Elimina: ° º . ( ) / , - y múltiples espacios
 * @param {string} str - String a normalizar
 * @returns {string} String normalizado en minúsculas sin caracteres especiales
 */
function normalizar(str) {
  return String(str || '').toLowerCase().replace(/°|º|\.|\(|\)|\/|,|-|\s+/g, '');
}

/**
 * Determina el estado de stock basado en la cantidad
 * @param {number|string} stock - Cantidad en stock
 * @returns {string} 'STOCK SUFICIENTE' o 'REALIZAR PEDIDO'
 */
function estadoDe(stock) {
  return Number(stock) > 0 ? 'STOCK SUFICIENTE' : 'REALIZAR PEDIDO';
}

/**
 * Valida que un string no esté vacío después de trim
 * @param {string} str - String a validar
 * @returns {boolean}
 */
function isNonEmptyString(str) {
  return typeof str === 'string' && str.trim().length > 0;
}

/**
 * Sanitiza un string para uso seguro en SQL (básico)
 * @param {string} str - String a sanitizar
 * @returns {string}
 */
function sanitizeForSql(str) {
  return String(str || '').replace(/'/g, "''");
}

module.exports = {
  normalizar,
  estadoDe,
  isNonEmptyString,
  sanitizeForSql
};