module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  migrationsDir: './migrations',
  driver: 'pg',
  verbose: true,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000
};