module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  verbose: true,
  collectCoverageFrom: [
    'routes/**/*.js',
    'controllers/**/*.js',
    'services/**/*.js',
    'middleware/**/*.js',
    'utils/**/*.js'
  ],
  coverageDirectory: 'coverage',
  moduleFileExtensions: ['js', 'json'],
  transform: {}
};