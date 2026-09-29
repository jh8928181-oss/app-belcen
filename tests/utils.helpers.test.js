const { normalizar, estadoDe, isNonEmptyString, sanitizeForSql } = require('../utils/helpers');

describe('normalizar', () => {
  test('normaliza caracteres especiales', () => {
    expect(normalizar('Tapa Dosf. N° 28 / Celeste')).toBe('tapadosfn28celeste');
    expect(normalizar('Etiqueta couche 90gr x 800 ml Don Lalo')).toBe('etiquetacouche90grx800mldonlalo');
  });

  test('maneja strings vacíos y null', () => {
    expect(normalizar('')).toBe('');
    expect(normalizar(null)).toBe('');
    expect(normalizar(undefined)).toBe('');
  });

  test('es idempotente', () => {
    const input = 'Tapa Dosf. N° 28 / Celeste';
    expect(normalizar(normalizar(input))).toBe(normalizar(input));
  });
});

describe('estadoDe', () => {
  test('stock positivo -> STOCK SUFICIENTE', () => {
    expect(estadoDe(10)).toBe('STOCK SUFICIENTE');
    expect(estadoDe(0.01)).toBe('STOCK SUFICIENTE');
    expect(estadoDe('5')).toBe('STOCK SUFICIENTE');
  });

  test('stock cero o negativo -> REALIZAR PEDIDO', () => {
    expect(estadoDe(0)).toBe('REALIZAR PEDIDO');
    expect(estadoDe(-5)).toBe('REALIZAR PEDIDO');
    expect(estadoDe('0')).toBe('REALIZAR PEDIDO');
  });
});

describe('isNonEmptyString', () => {
  test('acepta texto con contenido', () => {
    expect(isNonEmptyString('hola')).toBe(true);
    expect(isNonEmptyString('  con espacios  ')).toBe(true);
    expect(isNonEmptyString('0')).toBe(true);
  });

  test('rechaza vacío, solo espacios y no-strings', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('    ')).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(123)).toBe(false);
  });
});

describe('sanitizeForSql', () => {
  test('escapa comillas simples duplicándolas', () => {
    expect(sanitizeForSql("O'Brien")).toBe("O''Brien");
    expect(sanitizeForSql("' OR 1=1 --")).toBe("'' OR 1=1 --");
  });

  test('deja intactos los valores sin comillas', () => {
    expect(sanitizeForSql('Aceite de soya')).toBe('Aceite de soya');
  });

  test('maneja null y undefined como cadena vacía', () => {
    expect(sanitizeForSql(null)).toBe('');
    expect(sanitizeForSql(undefined)).toBe('');
  });
});
