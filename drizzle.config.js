import { defineConfig } from 'drizzle-kit';

// drizzle-kit CLI uses the `postgres` devDep (postgres-js, TCP) for migrations.
// Runtime app uses @neondatabase/serverless (HTTP) — see src/lib/db.js.
export default defineConfig({
  schema: './src/lib/schema.js',
  out:    './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
