import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env before running drizzle-kit.')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/data/schema',
  out: './drizzle',
  dbCredentials: { url },
})
