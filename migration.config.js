module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  migrationsDir: './migrations',
  driver: 'pg',
  verbose: true,
};