const crypto = require('crypto');
const { promisify } = require('util');
const scryptP = promisify(crypto.scrypt);
const { normalizar, estadoDe } = require('../utils/helpers');

async function hashPassword(password, salt) {
  const buf = await scryptP(password, salt, 64);
  return buf.toString('hex');
}

function esPasswordHasheada(stored) {
  return typeof stored === 'string' && /^[a-f0-9]{128}:[a-f0-9]{32}$/.test(stored);
}

describe('Auth utilities', () => {
  test('hashPassword genera hash consistente', async () => {
    const salt = 'abcdef1234567890';
    const hash1 = await hashPassword('testpass', salt);
    const hash2 = await hashPassword('testpass', salt);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(128);
  });

  test('hashPassword genera hash diferente con diferente salt', async () => {
    const hash1 = await hashPassword('testpass', 'salt1');
    const hash2 = await hashPassword('testpass', 'salt2');
    expect(hash1).not.toBe(hash2);
  });

  test('esPasswordHasheada detecta formato correcto', () => {
    const hash = 'a'.repeat(128) + ':' + 'b'.repeat(32);
    expect(esPasswordHasheada(hash)).toBe(true);
  });

  test('esPasswordHasheada rechaza formato incorrecto', () => {
    expect(esPasswordHasheada('plainpassword')).toBe(false);
    expect(esPasswordHasheada('hash:salt:extra')).toBe(false);
    expect(esPasswordHasheada('')).toBe(false);
    expect(esPasswordHasheada(null)).toBe(false);
  });
});

describe('Normalización de strings (utils/helpers)', () => {

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

describe('Estado de stock (utils/helpers)', () => {

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