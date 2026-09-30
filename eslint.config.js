const js = require('@eslint/js');
const globals = require('globals');

/**
 * Configuración de ESLint (formato plano, ESLint >= 9).
 *
 * Sustituye a .eslintrc.js, que ESLint 9 ya no lee.
 * Ejecuta `npm run lint` para revisar y `npm run lint:fix` para autocorregir.
 */
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'Temp/**',
      'public/**',
      'migrations/**',
      'scripts/**',
      'check-*.js',
      // Scripts ad-hoc locales con credenciales de BD escritas en el archivo.
      // No se versionan: ver .gitignore.
      'verify-*.js',
      'poblar.js',
      'actualizar_inventario.js'
    ]
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    },
    rules: {
      indent: ['error', 2, { SwitchCase: 1 }],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none'
      }],
      // El proyecto ya tiene varios catch (e) cuyo parámetro no se usa.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off'
    }
  },

  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest
      }
    }
  },

  // index.js grew organically and mixes 2-space and 4-space blocks.
  // Indent is relaxed there so the rule doesn't drown out real findings.
  {
    files: ['index.js'],
    rules: {
      indent: 'off',
      quotes: 'off'
    }
  }
];
